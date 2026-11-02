/**
 * A test deployment of the identity registry on the in-memory chain: the
 * scripts derived by the SDK from a test allowlist root and a test seal
 * seed, reference-script outputs for every script, a stand-in Module-1, and
 * the configuration record made by the vendored `buildConfigSeal`.
 */
import {
  allowlistRoot,
  createIdentityClients,
  deriveIdentityDeployment,
  IdentityContext,
  identityConfig,
  utf8ToHex,
  vectorIdFromSeed,
  type AdvertListed,
  type IdentityClients,
  type IdentityDeployment,
  type UnsignedTx,
} from '../../src/index.js';
import { buildConfigSeal, encodeIdentityAdvertDatum, plutusV3Hash } from '../../src/identity/vendor.js';
import type { ChainUtxo } from '../../src/chain/identity-chain.js';
import {
  aikenEvaluator,
  AP3X,
  FakeChain,
  fund,
  MODULE1_STAND_IN,
  referenceScriptUtxo,
  simulateTx,
  testWallet,
  type TestWallet,
} from './identity.js';

export interface World {
  chain: FakeChain;
  ctx: IdentityContext;
  clients: IdentityClients;
  deployment: IdentityDeployment;
  module1: string;
  deployer: TestWallet;
  allowlist: string[];
  sealTx: UnsignedTx;
  refs: Record<'identity' | 'attestation' | 'delegation' | 'vault' | 'legacy' | 'module1', ChainUtxo>;
}

/** Identifiers of the test allowlist (32-byte values from labels). */
export const TEST_ALLOWLIST: string[] = Array.from({ length: 9 }, (_, i) => vectorIdFromSeed('cd'.repeat(32), i));

export async function createWorld(options: { aiken?: boolean; advertListed?: AdvertListed; allowlist?: string[] } = {}): Promise<World> {
  const chain = new FakeChain();
  const deployer = testWallet('sdk world deployer');
  const seed = fund('sdk world: config seal seed', deployer, 50n * AP3X);
  const funds = fund('sdk world: deployer funds', deployer, 200n * AP3X);
  const allowlist = options.allowlist ?? TEST_ALLOWLIST;
  const legacyRoot = allowlistRoot(allowlist);
  const deployment = deriveIdentityDeployment({ legacyRoot, configSeed: seed.ref });
  const refs = {
    identity: referenceScriptUtxo('sdk world: identity reference script', deployment.identity.compiledCode),
    attestation: referenceScriptUtxo('sdk world: attestation reference script', deployment.attestation.compiledCode),
    delegation: referenceScriptUtxo('sdk world: delegation reference script', deployment.delegation.compiledCode),
    vault: referenceScriptUtxo('sdk world: vault reference script', deployment.vault.compiledCode),
    legacy: referenceScriptUtxo('sdk world: legacy reference script', deployment.legacy!.compiledCode),
    module1: referenceScriptUtxo('sdk world: module-1 reference script', MODULE1_STAND_IN),
  };
  chain.add(seed, funds, ...Object.values(refs));
  if (options.aiken === true) chain.evaluator = aikenEvaluator(chain);
  const module1 = plutusV3Hash(MODULE1_STAND_IN);
  chain.rewardBalances.set(module1, 0n);
  const config = identityConfig({
    legacyRoot,
    configSeed: seed.ref,
    identityPolicyId: deployment.identity.hash,
    identityRef: refs.identity.ref,
    attestationRef: refs.attestation.ref,
    delegationRef: refs.delegation.ref,
    vaultRef: refs.vault.ref,
    legacyRef: refs.legacy.ref,
    module1Ref: refs.module1.ref,
  }, {});
  const ctx = new IdentityContext({ chain, config });
  const { window, tx } = await ctx.prepare({ fundingAddress: deployer.address });
  const sealTx = buildConfigSeal(tx, {
    seed,
    seal: { hash: deployment.configSeal.hash, compiledCode: deployment.configSeal.compiledCode },
    configHolder: deployment.configHolder.hash,
    module1,
    window,
  });
  if (options.aiken === true) {
    const result = simulateTx(sealTx.txCborHex, chain.utxos, [deployer.key]);
    if (!result.passed) throw new Error(`the configuration seal fails: ${result.error ?? ''}`);
  }
  chain.apply(sealTx);
  const clients = createIdentityClients(ctx, options.advertListed === undefined ? {} : { advertListed: options.advertListed });
  return { chain, ctx, clients, deployment, module1, deployer, allowlist, sealTx, refs };
}

/** A new advert output (Part 2 §6.2, 14 fields) at the new advert address. */
export function advertUtxo(world: World, label: string, advert: {
  supplierPkh: string;
  agentId: string;
  capabilityId: string;
  price: bigint;
  buyerBond: bigint;
  supplierBond: bigint;
}): ChainUtxo {
  const datumHex = encodeIdentityAdvertDatum({
    supplier_pkh: advert.supplierPkh,
    capability_id: advert.capabilityId,
    model: 'qwen2.5:0.5b',
    max_output_tokens: 512,
    max_processing_ms: 60_000,
    price_lovelace: advert.price,
    supplier_bond_lovelace: advert.supplierBond,
    buyer_bond_lovelace: advert.buyerBond,
    endpoint_url: 'https://supplier.example/v1',
    detail_uri: 'https://supplier.example/detail.json',
    detail_hash: '00'.repeat(32),
    advertised_at: 1_761_000_000_000,
    status: 'Active',
    agent_id: advert.agentId,
  });
  const txHash = utf8ToHex(label.padEnd(32, '.').slice(0, 32));
  return { ref: { txHash, index: 0 }, address: world.deployment.advert.address, lovelace: 5n * AP3X, assets: {}, datumHex, scriptRef: null };
}
