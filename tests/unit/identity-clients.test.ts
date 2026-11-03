import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ed from '@noble/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentDelegator,
  CONTROLLER_SET,
  decodeAttestationDatum,
  decodeIdentityEscrowDatum,
  decodeVaultDatum,
  deriveIdentityDeployment,
  ed25519Key,
  envelopeSigStructure,
  escrowResource,
  HIRE_ACTION,
  IDENTITY_ENV_VARS,
  IdentityConfigError,
  identityConfig,
  IdentityContext,
  IdentityGateway,
  MAINNET_IDENTITY_DEPLOYMENT,
  OgmiosProvider,
  parseOutputReference,
  PartySpec,
  principalKeyDelegator,
  PURPOSE_ASSERTION,
  PURPOSE_DELEGATION,
  PURPOSE_TRANSACTION,
  requestSpecHash,
  vectorDid,
  verifyEnvelope,
} from '../../src/index.js';
import { hexToBytes } from '../../src/identity/vendor.js';
import { AP3X, fund, readTx, testWallet } from '../support/identity.js';
import { advertUtxo, createWorld, type World } from '../support/world.js';

const SDK_ROOT = join(import.meta.dirname, '../..');

async function agent(world: World, label: string, keys: Array<{ key: string; purposes: number }> = [], capabilities: string[] = []) {
  const controller = testWallet(`${label} controller`);
  world.chain.add(fund(`${label} funds`, controller, 200n * AP3X));
  const tx = await world.clients.registry.register({
    fundingAddress: controller.address,
    controller: controller.publicKey,
    name: label,
    parties: [new PartySpec({ role: 'Accountable', signer: CONTROLLER_SET })],
    keys: keys.map((k) => ed25519Key(k.key, k.purposes)),
    capabilities,
  });
  world.chain.apply(tx);
  return { id: tx.id, controller };
}

describe('Attestations', () => {
  it('attests with a checked COSE_Sign1 envelope, revokes, contests and refuses an early withdrawal', async () => {
    const world = await createWorld();
    const issuer = testWallet('attestation issuer');
    const subject = await agent(world, 'attestation subject');
    world.chain.add(fund('issuer funds', issuer, 50n * AP3X));
    const digest = createHash('sha256').update('document').digest('hex');
    const tx = await world.clients.attestations.attest({
      fundingAddress: issuer.address,
      subject: vectorDid(subject.id),
      issuer: issuer.publicKey,
      attType: 1,
      digest,
      format: 50,
      locator: 'https://example.org/doc.json',
      signEnvelope: (bytes) => ed.signAsync(bytes, hexToBytes(issuer.privateKey)),
    });
    const datum = decodeAttestationDatum(tx.outputs[tx.attestationOutput]!.datumHex!);
    expect(datum.issuedAt).toBe(tx.window.hi);
    expect(datum.envelopeSig).toHaveLength(128);
    expect(await verifyEnvelope(datum)).toBe(true);
    expect(await verifyEnvelope({ ...datum, issuedAt: datum.issuedAt + 1000 })).toBe(false);
    expect(Buffer.from(envelopeSigStructure(datum)).subarray(0, 12).toString('hex')).toBe('846a5369676e617475726531');
    expect(tx.requiredSigners).toEqual([issuer.keyHash]);
    world.chain.apply(tx);
    await expect(world.clients.attestations.attest({
      fundingAddress: issuer.address, subject: subject.id, issuer: issuer.publicKey, attType: 1, digest, signEnvelope: () => '00'.repeat(64),
    })).rejects.toMatchObject({ reason: 'envelope_invalid' });
    await expect(world.clients.attestations.withdraw({ fundingAddress: issuer.address, attestationId: tx.attestationId }))
      .rejects.toMatchObject({ reason: 'attestation_not_withdrawable' });
    const contest = await world.clients.attestations.contest({
      fundingAddress: subject.controller.address, attestationId: tx.attestationId, uri: 'https://subject.example/reply', sha256: digest,
    });
    expect(contest.requiredSigners).toEqual([subject.controller.keyHash]);
    const revoke = await world.clients.attestations.revoke({ fundingAddress: issuer.address, attestationId: tx.attestationId, reason: 4 });
    expect(decodeAttestationDatum(revoke.outputs[0]!.datumHex!).status).toEqual({ type: 'AttRevoked', at: revoke.window.lo, reason: 4 });
  });
});

describe('Delegations and vaults', () => {
  it('delegates with a fresh key, opens a vault, pays a listed advert with a buyer-bond top-up, closes and undelegates', async () => {
    const listed = vi.fn(() => true);
    const world = await createWorld({ advertListed: listed });
    const principal = testWallet('vault principal');
    const delegateKey = testWallet('delegate key');
    const supplierKey = testWallet('supplier key');
    world.chain.add(fund('principal funds', principal, 600n * AP3X), fund('delegate key funds', delegateKey, 20n * AP3X));
    const buyer = await agent(world, 'buyer agent', [{ key: delegateKey.publicKey, purposes: PURPOSE_DELEGATION }]);
    const supplier = await agent(world, 'supplier agent', [{ key: supplierKey.publicKey, purposes: PURPOSE_TRANSACTION + PURPOSE_ASSERTION }], ['llm.text.generate.v1']);
    const resource = escrowResource(world.deployment.escrow.hash);
    const owner = principalKeyDelegator(principal.keyHash);
    const delegate = await world.clients.delegations.delegate({
      fundingAddress: principal.address,
      delegator: owner,
      delegate: buyer.id,
      delegateKey: delegateKey.keyHash,
      actions: [HIRE_ACTION],
      resources: [resource],
      notAfter: 1_762_000_000_000 + 30 * 86_400_000,
      value: { perTx: 50n * AP3X, total: 200n * AP3X, periodMs: 86_400_000 },
    });
    expect(delegate.requiredSigners).toEqual([delegateKey.keyHash, principal.keyHash].sort());
    world.chain.apply(delegate);
    await expect(world.clients.delegations.delegate({
      fundingAddress: principal.address, delegator: owner, delegate: buyer.id, delegateKey: delegateKey.keyHash, actions: ['*'], notAfter: 1_762_100_000_000,
    })).rejects.toMatchObject({ reason: 'delegate_key_in_use' });

    const open = await world.clients.vaults.open({ fundingAddress: principal.address, owner, delegationId: delegate.delegationId, amount: 100n * AP3X });
    expect(decodeVaultDatum(open.outputs[open.vaultOutput]!.datumHex!)).toEqual({ type: 'Live', owner, delegation: delegate.delegationId, spent: 0n, periodStart: 0 });
    world.chain.apply(open);
    const vaultRef = open.outputs[open.vaultOutput]!.ref;

    const advert = advertUtxo(world, 'advert one', {
      supplierPkh: supplierKey.keyHash, agentId: supplier.id, capabilityId: 'llm.text.generate.v1', price: 100_000n, buyerBond: 0n, supplierBond: 0n,
    });
    world.chain.add(advert);
    const prompt = createHash('sha256').update('prompt').digest('hex');
    const pay = await world.clients.vaults.pay({ fundingAddress: delegateKey.address, vault: vaultRef, jobs: [{ advertRef: advert.ref, promptHash: prompt }] });
    expect(listed).toHaveBeenCalledOnce();
    const escrow = pay.outputs[pay.escrowOutputs[0]!]!;
    const escrowDatum = decodeIdentityEscrowDatum(escrow.datumHex!);
    // The output holds exactly payment + both bonds; the min-UTxO top-up went into the buyer bond.
    expect(escrow.lovelace).toBe(escrowDatum.payment_lovelace + escrowDatum.buyer_bond_lovelace + escrowDatum.supplier_bond_lovelace);
    expect(escrowDatum.buyer_bond_lovelace).toBeGreaterThan(0n);
    expect(escrowDatum).toMatchObject({ buyer_pkh: delegateKey.keyHash, agent_id: supplier.id, state: 'Open', request_spec_hash: requestSpecHash({ capability_id: 'llm.text.generate.v1', max_output_tokens: 512, model: 'qwen2.5:0.5b' }) });
    expect(escrowDatum.refund?.address.paymentCredential).toEqual({ type: 'Script', hash: world.deployment.vault.hash });
    expect(pay.requiredSigners).toContain(delegateKey.keyHash);
    const continuing = decodeVaultDatum(pay.outputs[pay.vaultOutput]!.datumHex!);
    expect(continuing).toMatchObject({ type: 'Live', spent: escrow.lovelace, periodStart: pay.window.hi });
    world.chain.apply(pay);

    const close = await world.clients.vaults.close({ fundingAddress: principal.address, vaults: [pay.outputs[pay.vaultOutput]!.ref] });
    expect(close.requiredSigners).toContain(principal.keyHash);
    const undelegate = await world.clients.delegations.undelegate({ fundingAddress: principal.address, delegationId: delegate.delegationId });
    expect(readTx(undelegate.txCborHex).redeemers.map((r) => r.tag)).toEqual(['spend', 'mint']);
  });

  it('accepts an agent delegator and refuses an unlisted advert', async () => {
    const world = await createWorld({ advertListed: () => false });
    const key = testWallet('agent delegate key');
    const owner = await agent(world, 'owner agent');
    const buyer = await agent(world, 'agent buyer', [{ key: key.publicKey, purposes: PURPOSE_DELEGATION }]);
    const tx = await world.clients.delegations.delegate({
      fundingAddress: owner.controller.address, delegator: agentDelegator(owner.id), delegate: buyer.id, delegateKey: key.keyHash,
      actions: ['marketplace.*'], resources: ['*'], notAfter: 1_763_000_000_000, value: { perTx: 10n * AP3X, total: 10n * AP3X, periodMs: 1 },
    });
    expect(tx.requiredSigners).toContain(owner.controller.keyHash);
    world.chain.apply(tx);
    const open = await world.clients.vaults.open({ fundingAddress: owner.controller.address, owner: agentDelegator(owner.id), delegationId: tx.delegationId, amount: 20n * AP3X });
    world.chain.apply(open);
    const advert = advertUtxo(world, 'unlisted advert', { supplierPkh: key.keyHash, agentId: buyer.id, capabilityId: 'x', price: 1n, buyerBond: 0n, supplierBond: 0n });
    world.chain.add(advert);
    await expect(world.clients.vaults.pay({ fundingAddress: owner.controller.address, vault: open.outputs[0]!.ref, jobs: [{ advertRef: advert.ref, promptHash: '00'.repeat(32) }] }))
      .rejects.toMatchObject({ reason: 'advert_key_not_listed' });
  });
});

describe('IdentityGateway', () => {
  const resolution = {
    didDocument: {
      id: 'did:vector:' + 'ab'.repeat(32),
      verificationMethod: [{ id: '#k1', publicKeyMultibase: 'z6Mk' }],
      capabilityInvocation: ['#c0ffee'],
    },
    didDocumentMetadata: {
      canonicalId: 'did:vector:' + 'ab'.repeat(32), versionId: '3', vectorOrigin: 'native',
      vectorStatus: { status: 'active', effective: 'suspended', effectiveReason: 'unaccountable' },
      vectorKeys: [{ id: '#k1', type: 'Ed25519', purposes: ['authentication', 'transaction'] }],
      vectorLedger: { txId: 'cd'.repeat(32), outputIndex: 0 },
    },
    didResolutionMetadata: { contentType: 'application/did' },
  };

  it('resolves with version options and reads the current record', async () => {
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      expect(init.headers.Accept).toBe('application/did-resolution');
      if (url.includes('versionTime')) {
        expect(url).toBe(`https://gw.example/1.0/identifiers/did:vector:${'ab'.repeat(32)}?versionTime=2026-01-02T03%3A04%3A05Z`);
      }
      return new Response(JSON.stringify(resolution), { status: 200, headers: { 'content-type': 'application/did-resolution' } });
    });
    const gateway = new IdentityGateway('https://gw.example/', { fetch: fetch as never });
    const result = await gateway.resolve(vectorDid('ab'.repeat(32)), { versionTime: new Date('2026-01-02T03:04:05.678Z') });
    expect(result.error).toBeNull();
    const view = await gateway.currentRecord('ab'.repeat(32));
    expect(view).toMatchObject({ vectorId: 'ab'.repeat(32), effective: 'suspended', effectiveReason: 'unaccountable', versionId: '3', controllerKeyHash: 'c0ffee' });
    expect(view.recordOutput).toBe(`${'cd'.repeat(32)}#0`);
    expect(view.hasKey('k1', 'transaction')).toBe(true);
  });

  it('turns a DID error into DidResolutionError and a non-JSON answer into ConnectionError', async () => {
    const notFound = { didResolutionMetadata: { error: { type: 'https://www.w3.org/ns/did#NOT_FOUND', title: 'not found' } } };
    let body = JSON.stringify(notFound);
    const fetch = vi.fn(async () => new Response(body, { status: 404 }));
    const gateway = new IdentityGateway('https://gw.example', { fetch: fetch as never });
    expect((await gateway.resolve('did:vector:' + '00'.repeat(32))).error).toBe('NOT_FOUND');
    await expect(gateway.currentRecord('00'.repeat(32))).rejects.toMatchObject({ name: 'DidResolutionError', error: 'NOT_FOUND', status: 404 });
    body = '<html>';
    await expect(gateway.resolve('did:vector:' + '00'.repeat(32))).rejects.toMatchObject({ name: 'ConnectionError' });
  });
});

describe('identityConfig', () => {
  it('reads the Python SDK variable names, checks values and names the variable in errors', () => {
    const env = {
      VECTOR_IDENTITY_LEGACY_ROOT: '11'.repeat(32),
      VECTOR_IDENTITY_CONFIG_SEED: `${'ab'.repeat(32)}#24`,
      VECTOR_IDENTITY_REF_UTXO: `${'cd'.repeat(32)}#1`,
      VECTOR_KOIOS_URL: 'https://koios.example/api/v1/',
      VECTOR_MARKETPLACE_INDEXER_URL: 'https://indexer.example/',
    };
    const config = identityConfig({}, env);
    expect(config).toMatchObject({
      legacyRoot: '11'.repeat(32), configSeed: { txHash: 'ab'.repeat(32), index: 24 }, identityRef: { txHash: 'cd'.repeat(32), index: 1 },
      koiosUrl: 'https://koios.example/api/v1', indexerUrl: 'https://indexer.example', gatewayUrl: 'https://id.vector.apexfusion.org',
      ogmiosUrl: 'https://ogmios.vector.mainnet.apexfusion.org', legacyHash: 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01',
    });
    expect(Object.values(IDENTITY_ENV_VARS)).toContain('VECTOR_IDENTITY_POLICY_ID');
    expect(() => identityConfig({}, { VECTOR_IDENTITY_CONFIG_SEED: 'nope' })).toThrow(/VECTOR_IDENTITY_CONFIG_SEED/);
    const wrongPolicy = identityConfig({ identityPolicyId: '00'.repeat(28) }, env);
    expect(() => new IdentityContext({ config: wrongPolicy }).scripts).toThrow(IdentityConfigError);
  });

  it('derives the applied scripts (the config_seal hash matches `aiken blueprint apply`)', () => {
    const d = deriveIdentityDeployment({ legacyRoot: '11'.repeat(32), configSeed: { txHash: 'ab'.repeat(32), index: 24 } });
    expect(d.configHolder.hash).toBe('288fea77a0f674c6080aadd8ed3ca42cd5a920bf1f00c0d3e63306e4');
    expect(d.configSeal.hash).toBe('a12c8b6106f2a6704b64cfa1669663d6e757197a77d2ea6f685ad43a');
    expect(d.advert.hash).toBe('f36e366e06d44806' + d.advert.hash.slice(16));
    expect(d.legacy?.address).toBe('addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42');
  });

  /** The published mainnet record, vendored from agents-marketplace (VENDORED-FROM.md). */
  const published = JSON.parse(readFileSync(
    join(SDK_ROOT, 'tests/vendor/agents-marketplace/contracts/identity-marketplace/deploy/mainnet/deployment.json'),
    'utf8',
  )) as {
    network: string;
    legacy_hash: string;
    legacy_root: string;
    config_seed: string;
    identity_hash: string;
    scripts: Record<string, { hash: string; address: string; compiled_code: string }>;
    refs: Record<string, string>;
  };
  const publishedRef = (name: string) => parseOutputReference(published.refs[name]!);
  const SCRIPT_NAMES = {
    configHolder: 'config_holder', configSeal: 'config_seal', identity: 'identity', attestation: 'attestation',
    delegation: 'delegation', escrow: 'escrow', vault: 'vault', advert: 'advert',
  } as const;

  it('takes the published mainnet deployment when nothing is set and derives the 8 script hashes of deployment.json', () => {
    expect(published.network).toBe('mainnet');
    expect(MAINNET_IDENTITY_DEPLOYMENT).toEqual({
      legacyHash: published.legacy_hash,
      legacyRoot: published.legacy_root,
      configSeed: parseOutputReference(published.config_seed),
      identityPolicyId: published.identity_hash,
      identityRef: publishedRef('identity'),
      attestationRef: publishedRef('attestation'),
      delegationRef: publishedRef('delegation'),
      vaultRef: publishedRef('vault'),
      escrowRef: publishedRef('escrow'),
      advertRef: publishedRef('advert'),
    });
    const config = identityConfig({}, {});
    expect(config).toMatchObject({
      legacyRoot: published.legacy_root,
      configSeed: parseOutputReference(published.config_seed),
      legacyHash: published.legacy_hash,
      identityPolicyId: published.identity_hash,
      identityRef: publishedRef('identity'),
      attestationRef: publishedRef('attestation'),
      delegationRef: publishedRef('delegation'),
      vaultRef: publishedRef('vault'),
      legacyRef: null,
      module1Ref: null,
      configUtxo: null,
    });
    // The context derives the scripts and checks the derived policy ID against the published one.
    const scripts = new IdentityContext({ config }).scripts;
    expect(Object.keys(published.scripts).sort()).toEqual(Object.values(SCRIPT_NAMES).sort());
    for (const [field, name] of Object.entries(SCRIPT_NAMES)) {
      const script = scripts[field as keyof typeof SCRIPT_NAMES];
      const record = published.scripts[name]!;
      expect(script.hash, name).toBe(record.hash);
      expect(script.address, name).toBe(record.address);
      expect(script.compiledCode, name).toBe(record.compiled_code);
    }
  });

  it('lets a set value win over a mainnet default and keeps the rules for partial settings', () => {
    const own = { VECTOR_IDENTITY_LEGACY_ROOT: '11'.repeat(32), VECTOR_IDENTITY_CONFIG_SEED: `${'ab'.repeat(32)}#24` };
    const ref = identityConfig({}, { VECTOR_IDENTITY_REF_UTXO: `${'cd'.repeat(32)}#1` });
    expect(ref.identityRef).toEqual({ txHash: 'cd'.repeat(32), index: 1 });
    expect(ref.attestationRef).toEqual(MAINNET_IDENTITY_DEPLOYMENT.attestationRef);
    expect(identityConfig({ identityRef: null }, {}).identityRef).toBeNull();
    // Another root and seed: their own deployment, without the published policy ID and reference outputs.
    expect(identityConfig({}, own)).toMatchObject({
      legacyRoot: '11'.repeat(32), configSeed: { txHash: 'ab'.repeat(32), index: 24 },
      identityPolicyId: null, identityRef: null, attestationRef: null, delegationRef: null, vaultRef: null,
    });
    // The published root and seed, set by hand, give the same configuration as no setting.
    expect(identityConfig({}, {
      VECTOR_IDENTITY_LEGACY_ROOT: MAINNET_IDENTITY_DEPLOYMENT.legacyRoot,
      VECTOR_IDENTITY_CONFIG_SEED: published.config_seed,
    })).toEqual(identityConfig({}, {}));
    // The root and the seed come together: one of them alone gets no default for the other.
    expect(() => new IdentityContext({ config: identityConfig({}, { VECTOR_IDENTITY_LEGACY_ROOT: own.VECTOR_IDENTITY_LEGACY_ROOT }) }).scripts)
      .toThrow(/missing deployment values: VECTOR_IDENTITY_CONFIG_SEED \(/);
    expect(identityConfig({}, { VECTOR_IDENTITY_LEGACY_HASH: '00'.repeat(28) }))
      .toMatchObject({ legacyRoot: null, configSeed: null, identityPolicyId: null, identityRef: null });
    // A policy ID that contradicts the published values fails when the context derives the scripts.
    expect(() => new IdentityContext({ config: identityConfig({}, { VECTOR_IDENTITY_POLICY_ID: '00'.repeat(28) }) }).scripts)
      .toThrow(/VECTOR_IDENTITY_POLICY_ID is 0{56}, but/);
  });

  it('sets no deployment value on the testnet', () => {
    for (const config of [
      identityConfig({}, { VECTOR_IDENTITY_NETWORK: 'testnet' }),
      identityConfig({ network: 'testnet' }, { VECTOR_IDENTITY_NETWORK: 'mainnet' }),
    ]) {
      expect(config).toMatchObject({
        legacyRoot: null, configSeed: null, identityPolicyId: null,
        identityRef: null, attestationRef: null, delegationRef: null, vaultRef: null,
      });
      expect(() => new IdentityContext({ config }).scripts).toThrow(/VECTOR_IDENTITY_LEGACY_ROOT, VECTOR_IDENTITY_CONFIG_SEED/);
    }
    expect(identityConfig({}, { VECTOR_IDENTITY_NETWORK: 'testnet', VECTOR_IDENTITY_LEGACY_ROOT: '11'.repeat(32) }).legacyRoot).toBe('11'.repeat(32));
    expect(() => identityConfig({}, { VECTOR_IDENTITY_NETWORK: 'preprod' })).toThrow(/VECTOR_IDENTITY_NETWORK: expected mainnet or testnet/);
  });
});

describe('OgmiosProvider identity reads', () => {
  /** A provider from a fresh module that sees the mocked fetch: Ogmios answers by method, Koios answers `koios`. */
  async function provider(answers: Record<string, unknown>, koios?: unknown) {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', undefined);
    const fetchMock = vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, headers: init.headers });
      if (url.includes('koios')) return new Response(JSON.stringify(koios), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: answers[body.method] }), { status: 200 });
    });
    vi.doMock('cross-fetch', () => ({ default: fetchMock }));
    vi.resetModules();
    const { OgmiosProvider: Fresh } = await import('../../src/chain/ogmios-provider.js'); // a fresh module that sees the mocked fetch
    const p = new Fresh({ ogmiosUrl: 'https://ogmios.example', submitUrl: 'https://submit.example', koiosUrl: 'https://koios.example/api/v1', koiosToken: 't0ken' });
    return { p, calls };
  }

  afterEach(() => {
    vi.doUnmock('cross-fetch');
  });

  it('parses Ogmios v6 outputs, reward summaries in both shapes, the slot clock and Koios token lookups', async () => {
    const utxo = {
      transaction: { id: 'AB'.repeat(32) }, index: 1, address: 'addr1x',
      value: { ada: { lovelace: 17000000 }, ['cd'.repeat(28)]: { '0a': 1 } },
      datum: 'D87980', script: { language: 'plutus:v3', cbor: '450101002499' },
    };
    const { p, calls } = await provider({
      'queryLedgerState/utxo': [utxo],
      'queryLedgerState/rewardAccountSummaries': [{ from: 'script', credential: 'ee'.repeat(28), rewards: { ada: { lovelace: 42 } }, deposit: { ada: { lovelace: 2 } } }],
      'queryNetwork/startTime': '2025-08-29T16:40:00Z',
      'queryLedgerState/eraSummaries': [{ start: { time: { seconds: 0 }, slot: 0 }, parameters: { slotLength: { milliseconds: 1000 } } }],
      'queryNetwork/tip': { slot: 37157464, id: 'ff' },
    }, [{ tx_hash: 'ab'.repeat(32), tx_index: 1, is_spent: false }]);
    const [u] = await p.queryUtxosAt('addr1x');
    expect(u).toEqual({ ref: { txHash: 'ab'.repeat(32), index: 1 }, address: 'addr1x', lovelace: 17_000_000n, assets: { [`${'cd'.repeat(28)}0a`]: 1n }, datumHex: 'd87980', scriptRef: '450101002499' });
    expect(await p.getRewardBalance('ee'.repeat(28), 1)).toBe(42n);
    expect(await p.getSlotConfig()).toEqual({ zeroTimeMs: 1_756_485_600_000, zeroSlot: 0, slotLengthMs: 1000 });
    expect(await p.getTipSlot()).toBe(37157464);
    expect(await p.queryTokenUtxos('cd'.repeat(28), '0a')).toHaveLength(1);
    const koiosCall = calls.find((c) => c.url.includes('koios'))!;
    expect(koiosCall.url).toBe('https://koios.example/api/v1/asset_utxos');
    expect(koiosCall.headers.Authorization).toBe('Bearer t0ken');
    expect(OgmiosProvider).toBeDefined();
  });

  describe('reward balance of a script credential', () => {
    const hash = 'a38f97f3d0228eae7df6785986d377e34034d43c2aa46aa9609aef89';
    // The reward address that Koios lists for this script credential: CIP-19 header 0xf1 (script, network 1).
    const rewardAddress = 'stake17x3cl9ln6q3gatna7eu9npknwl35qdx58s42g64fvzdwlzg3fnwlc';
    const noSummary = { 'queryLedgerState/rewardAccountSummaries': [] };
    const row = { stake_address: rewardAddress, delegated_pool: null, deposit: '500000000' };

    it('takes the Ogmios summary when there is one', async () => {
      const { p, calls } = await provider({
        'queryLedgerState/rewardAccountSummaries': [{ from: 'script', credential: hash, rewards: { ada: { lovelace: 42 } } }],
      });
      expect(await p.getRewardBalance(hash, 1)).toBe(42n);
      expect(calls.map((c) => c.url)).toEqual(['https://ogmios.example']);
    });

    it('reads Koios account_info when Ogmios has no summary (a registered credential without delegation)', async () => {
      const { p, calls } = await provider(noSummary, [{ ...row, status: 'registered', rewards_available: '1500000' }]);
      expect(await p.getRewardBalance(hash, 1)).toBe(1_500_000n);
      expect(calls.map((c) => c.url)).toEqual(['https://ogmios.example', 'https://koios.example/api/v1/account_info']);
      expect(calls[1]!.body).toEqual({ _stake_addresses: [rewardAddress] });
      expect(calls[1]!.headers.Authorization).toBe('Bearer t0ken');
    });

    it('is null when Koios does not list the reward address as registered', async () => {
      for (const koios of [[{ ...row, status: 'not registered', rewards_available: '7' }], []]) {
        const { p } = await provider(noSummary, koios);
        expect(await p.getRewardBalance(hash, 1)).toBeNull();
      }
    });
  });
});

describe('vendored files', () => {
  it('matches VENDORED-FROM.md in both directions', () => {
    const table = readFileSync(join(SDK_ROOT, 'VENDORED-FROM.md'), 'utf8');
    expect(table).toMatch(/\| Commit \| `[0-9a-f]{40}` \|/);
    const rows = [...table.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => ({ path: m[1]!, source: m[2]!, hash: m[3]! }));
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) {
      expect(createHash('sha256').update(readFileSync(join(SDK_ROOT, row.path))).digest('hex'), row.path).toBe(row.hash);
      expect(row.path.endsWith(row.source)).toBe(true);
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(relative(SDK_ROOT, path).split('\\').join('/'));
      }
    };
    walk(join(SDK_ROOT, 'src/vendor'));
    walk(join(SDK_ROOT, 'tests/vendor'));
    expect(files.sort()).toEqual(rows.map((r) => r.path).sort());
  });
});
