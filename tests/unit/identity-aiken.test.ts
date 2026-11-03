/**
 * The identity clients against the real applied scripts: every transaction
 * is evaluated with `aiken tx simulate` (aiken v1.1.21) twice: once as the
 * chain evaluation inside the build (the measured units), and once more as
 * the final, signed transaction. The scripts come from the vendored
 * blueprint with the SDK's parameter application, which must equal
 * `aiken blueprint apply`. Skipped when aiken v1.1.21 is not on PATH.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { blueprintScript } from '../vendor/agents-marketplace/tests/legacy-registry/harness/blueprint.js';
import { constr } from '../vendor/agents-marketplace/tests/legacy-registry/harness/data.js';
import { fromHex, scriptHash, toHex, type KeyPair } from '../vendor/agents-marketplace/tests/legacy-registry/harness/ledger.js';
import {
  CONTROLLER_SET,
  ed25519Key,
  escrowResource,
  HIRE_ACTION,
  module1Signer,
  PartySpec,
  principalKeyDelegator,
  PURPOSE_ASSERTION,
  PURPOSE_DELEGATION,
  PURPOSE_TRANSACTION,
  type UnsignedTx,
} from '../../src/index.js';
import { aikenAvailable, AP3X, fund, simulateTx, testWallet, type TestWallet } from '../support/identity.js';
import { advertUtxo, createWorld, type World } from '../support/world.js';

const BLUEPRINT = join(import.meta.dirname, '../../src/vendor/agents-marketplace/contracts/identity-marketplace/plutus.json');

/** The final transaction passes every script, within the units it declares. */
function passes(world: World, tx: UnsignedTx, keys: KeyPair[]): void {
  const result = simulateTx(tx.txCborHex, world.chain.utxos, keys);
  expect(result.passed, result.error).toBe(true);
  expect(result.verdicts).toHaveLength(tx.redeemers.length);
  result.verdicts.forEach((v, i) => {
    expect(v.passed).toBe(true);
    expect(v.mem).toBeGreaterThan(0);
    expect(BigInt(v.mem!)).toBeLessThanOrEqual(tx.redeemers[i]!.exUnits.mem);
    expect(BigInt(v.cpu!)).toBeLessThanOrEqual(tx.redeemers[i]!.exUnits.steps);
  });
  world.chain.apply(tx);
}

describe.skipIf(!aikenAvailable())('identity clients against the applied scripts (aiken tx simulate)', () => {
  let world: World;
  const wallets: Record<string, TestWallet> = {};
  const ids: Record<string, string> = {};
  const wallet = (label: string): TestWallet => (wallets[label] ??= testWallet(`aiken ${label}`));

  beforeAll(async () => {
    world = await createWorld({ aiken: true, advertListed: () => true });
  }, 120_000);

  it('applies the parameters byte for byte as `aiken blueprint apply`', () => {
    const d = world.deployment;
    const bytes = (hex: string) => fromHex(hex);
    const hash = (title: string, params: Parameters<typeof blueprintScript>[2]) => toHex(scriptHash(blueprintScript(BLUEPRINT, title, params)));
    expect(hash('config.config_seal.mint', [constr(0, bytes(d.configSeed.txHash), BigInt(d.configSeed.index)), bytes(d.configHolder.hash)])).toBe(d.configSeal.hash);
    expect(hash('identity.identity.mint', [bytes(d.legacyHash), bytes(d.legacyRoot), bytes(d.configSeal.hash), bytes(d.configHolder.hash)])).toBe(d.identity.hash);
    expect(hash('attestation.attestation.mint', [bytes(d.identity.hash)])).toBe(d.attestation.hash);
    expect(hash('delegation.delegation.mint', [bytes(d.identity.hash)])).toBe(d.delegation.hash);
    expect(hash('escrow.escrow.spend', [bytes(d.identity.hash)])).toBe(d.escrow.hash);
    expect(hash('vault.vault.spend', [bytes(d.identity.hash), bytes(d.delegation.hash), bytes(d.escrow.hash)])).toBe(d.vault.hash);
  });

  it('Register: a root record with a listed key passes the identity mint', async () => {
    const controller = wallet('controller');
    const supplierKey = wallet('supplier key');
    world.chain.add(fund('aiken controller funds', controller, 300n * AP3X));
    const tx = await world.clients.registry.register({
      fundingAddress: controller.address,
      controller: controller.publicKey,
      name: 'supplier agent',
      capabilities: ['llm.text.generate.v1'],
      parties: [new PartySpec({ role: 'Accountable', signer: CONTROLLER_SET })],
      keys: [ed25519Key(supplierKey.publicKey, PURPOSE_TRANSACTION + PURPOSE_ASSERTION)],
    });
    passes(world, tx, [controller.key, supplierKey.key]);
    ids.supplier = tx.id;
  });

  it('Update with Module-1 consent: the withdrawal of the whole reward balance passes', async () => {
    const controller = wallet('controller');
    world.chain.advance(120);
    const record = await world.clients.registry.record(ids.supplier!);
    const tx = await world.clients.registry.update({
      fundingAddress: controller.address,
      agent: ids.supplier!,
      parties: [...record.datum.parties, new PartySpec({ role: 'Responsible', signer: module1Signer(world.module1) })],
    });
    expect(tx.redeemers.map((r) => r.label)).toEqual(['identity Update', 'Module-1 Consent']);
    passes(world, tx, [controller.key]);
  });

  it('Attest: a registered issuer key attests about the agent', async () => {
    const controller = wallet('controller');
    const issuerKey = wallet('supplier key');
    world.chain.advance(120);
    world.chain.add(fund('aiken issuer funds', issuerKey, 50n * AP3X));
    const tx = await world.clients.attestations.attest({
      fundingAddress: issuerKey.address,
      subject: ids.supplier!,
      issuer: issuerKey.publicKey,
      issuerId: ids.supplier!,
      attType: 1,
      digest: createHash('sha256').update('aiken document').digest('hex'),
    });
    passes(world, tx, [issuerKey.key, controller.key]);
  });

  it('Delegate and Vault Pay: a principal delegates to a buyer agent, opens a vault and pays a listed advert', async () => {
    const principal = wallet('principal');
    const buyerController = wallet('buyer controller');
    const delegateKey = wallet('delegate key');
    world.chain.advance(120);
    world.chain.add(fund('aiken principal funds', principal, 500n * AP3X), fund('aiken buyer funds', buyerController, 100n * AP3X));
    const buyer = await world.clients.registry.register({
      fundingAddress: buyerController.address,
      controller: buyerController.publicKey,
      name: 'buyer agent',
      parties: [new PartySpec({ role: 'Accountable', signer: CONTROLLER_SET })],
      keys: [ed25519Key(delegateKey.publicKey, PURPOSE_DELEGATION)],
    });
    passes(world, buyer, [buyerController.key, delegateKey.key]);
    world.chain.advance(120);
    const owner = principalKeyDelegator(principal.keyHash);
    const delegate = await world.clients.delegations.delegate({
      fundingAddress: principal.address,
      delegator: owner,
      delegate: buyer.id,
      delegateKey: delegateKey.keyHash,
      actions: [HIRE_ACTION],
      resources: [escrowResource(world.deployment.escrow.hash)],
      notAfter: 1_762_000_000_000 + 30 * 86_400_000,
      value: { perTx: 50n * AP3X, total: 200n * AP3X, periodMs: 86_400_000 },
    });
    passes(world, delegate, [principal.key, delegateKey.key]);
    world.chain.advance(120);
    const open = await world.clients.vaults.open({ fundingAddress: principal.address, owner, delegationId: delegate.delegationId, amount: 100n * AP3X });
    expect(open.redeemers).toEqual([]);
    world.chain.apply(open);
    world.chain.advance(120);
    const advert = advertUtxo(world, 'aiken advert', {
      supplierPkh: wallet('supplier key').keyHash, agentId: ids.supplier!, capabilityId: 'llm.text.generate.v1', price: 2n * AP3X, buyerBond: 500_000n, supplierBond: 500_000n,
    });
    world.chain.add(advert, fund('aiken delegate key funds', delegateKey, 20n * AP3X));
    const pay = await world.clients.vaults.pay({
      fundingAddress: delegateKey.address,
      vault: open.outputs[open.vaultOutput]!.ref,
      jobs: [{ advertRef: advert.ref, promptHash: createHash('sha256').update('aiken prompt').digest('hex') }],
    });
    expect(pay.outputs[pay.escrowOutputs[0]!]!.lovelace).toBe(3n * AP3X);
    passes(world, pay, [delegateKey.key]);
  });
});
