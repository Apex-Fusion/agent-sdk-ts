/**
 * The applied scripts of an identity deployment (Part 2 §2, §3.8).
 *
 * The vendored blueprint `contracts/identity-marketplace/plutus.json` (CIP-57,
 * https://cips.cardano.org/cip/CIP-0057) holds the unapplied validators.
 * `applyScriptParameters` turns `(program v term)` into
 * `(program v [term (con data p)])` for each parameter, in blueprint order,
 * with the UPLC code of the Aiken toolchain (`@lucid-evolution/uplc`, the
 * `apply_params_to_script` of the `uplc` crate), so the result is byte for
 * byte the result of `aiken blueprint apply` (a test checks every script).
 * The parameters are Plutus Data in the encoding of Aiken `cbor.serialise`.
 *
 * Deployment order (§3.8): `config_holder`, `config_seal(seed, holder)`,
 * `identity(legacy_hash, legacy_root, config_policy, config_holder)`, then
 * `attestation`, `delegation` and `escrow` with the identity hash, `vault`
 * with the identity, delegation and escrow hashes. `advert` has no parameter.
 */
import { apply_params_to_script } from '@lucid-evolution/uplc';
import identityBlueprint from '../vendor/agents-marketplace/contracts/identity-marketplace/plutus.json';
import { REGISTRY_POLICY_ID, REGISTRY_SCRIPT_CBOR } from '../constants.js';
import { IdentityConfigError } from './errors.js';
import {
  bytesToHex,
  encodePlutusData,
  enterpriseAddress,
  hexToBytes,
  plutusV3Hash,
  type NetworkId,
  type OutputReference,
  type PlutusData,
} from './vendor.js';

/** One applied validator. */
export interface AppliedScript {
  /** The blueprint handler that the code comes from, for example `identity.identity.mint`. */
  title: string;
  /** The script hash, which is also the policy ID. */
  hash: string;
  /** One CBOR byte string around the flat program (CIP-57 `compiledCode`). */
  compiledCode: string;
  /** The enterprise address of the script (no stake credential). */
  address: string;
}

/** Every script of one identity deployment. */
export interface IdentityDeployment {
  networkId: NetworkId;
  legacyHash: string;
  legacyRoot: string;
  configSeed: OutputReference;
  configHolder: AppliedScript;
  /** `config_seal`; its hash is the policy of the configuration token. */
  configSeal: AppliedScript;
  /** `identity`; its hash is the identity policy ID and its address is IA. */
  identity: AppliedScript;
  attestation: AppliedScript;
  delegation: AppliedScript;
  escrow: AppliedScript;
  vault: AppliedScript;
  advert: AppliedScript;
  /** The deployed legacy registry when `legacyHash` is `be1a0a29…`; else its code is unknown here (use a reference script). */
  legacy: AppliedScript | null;
}

/**
 * Applies Plutus Data parameters to a CIP-57 `compiledCode`, one after the
 * other, as `aiken blueprint apply` does.
 */
export function applyScriptParameters(compiledCode: string, parameters: readonly PlutusData[]): string {
  if (parameters.length === 0) return compiledCode;
  const list = encodePlutusData({ kind: 'list', items: [...parameters] });
  return bytesToHex(apply_params_to_script(list, hexToBytes(compiledCode)));
}

/** A blueprint validator with `parameters` applied. */
export function blueprintScript(title: string, parameters: readonly PlutusData[], networkId: NetworkId): AppliedScript {
  const validator = identityBlueprint.validators.find((v) => v.title === title);
  if (validator === undefined) throw new IdentityConfigError(`the identity blueprint has no validator ${title}`);
  const expected = 'parameters' in validator ? (validator.parameters?.length ?? 0) : 0;
  if (expected !== parameters.length) {
    throw new IdentityConfigError(`${title} takes ${expected} parameters, not ${parameters.length}`);
  }
  const compiledCode = applyScriptParameters(validator.compiledCode, parameters);
  const hash = plutusV3Hash(compiledCode);
  if (parameters.length === 0 && hash !== validator.hash) throw new IdentityConfigError(`${title}: the code does not match the blueprint hash`);
  return { title, hash, compiledCode, address: enterpriseAddress({ type: 'Script', hash }, networkId) };
}

const bytes = (hex: string): PlutusData => ({ kind: 'bytes', hex });

/**
 * The scripts that follow from the free deployment values: the allowlist
 * root, the seed of `config_seal` and the legacy hash.
 */
export function deriveIdentityDeployment(args: {
  legacyRoot: string;
  configSeed: OutputReference;
  legacyHash?: string;
  networkId?: NetworkId;
}): IdentityDeployment {
  const networkId = args.networkId ?? 1;
  const legacyHash = args.legacyHash ?? REGISTRY_POLICY_ID;
  if (!/^[0-9a-f]{64}$/.test(args.legacyRoot)) throw new IdentityConfigError('legacy_root must be 32 bytes (64 lowercase hex characters)');
  if (!/^[0-9a-f]{56}$/.test(legacyHash)) throw new IdentityConfigError('legacy_hash must be 28 bytes (56 lowercase hex characters)');
  const seed: PlutusData = {
    kind: 'constr',
    index: 0n,
    fields: [bytes(args.configSeed.txHash), { kind: 'int', value: BigInt(args.configSeed.index) }],
  };
  const configHolder = blueprintScript('config.config_holder.spend', [], networkId);
  const configSeal = blueprintScript('config.config_seal.mint', [seed, bytes(configHolder.hash)], networkId);
  const identity = blueprintScript(
    'identity.identity.mint',
    [bytes(legacyHash), bytes(args.legacyRoot), bytes(configSeal.hash), bytes(configHolder.hash)],
    networkId,
  );
  const attestation = blueprintScript('attestation.attestation.mint', [bytes(identity.hash)], networkId);
  const delegation = blueprintScript('delegation.delegation.mint', [bytes(identity.hash)], networkId);
  const escrow = blueprintScript('escrow.escrow.spend', [bytes(identity.hash)], networkId);
  const vault = blueprintScript('vault.vault.spend', [bytes(identity.hash), bytes(delegation.hash), bytes(escrow.hash)], networkId);
  const advert = blueprintScript('advert.advert.spend', [], networkId);
  const legacy: AppliedScript | null = legacyHash === REGISTRY_POLICY_ID
    ? {
        title: 'registry.registry.mint',
        hash: REGISTRY_POLICY_ID,
        compiledCode: REGISTRY_SCRIPT_CBOR,
        address: enterpriseAddress({ type: 'Script', hash: REGISTRY_POLICY_ID }, networkId),
      }
    : null;
  return {
    networkId,
    legacyHash,
    legacyRoot: args.legacyRoot,
    configSeed: { txHash: args.configSeed.txHash, index: args.configSeed.index },
    configHolder,
    configSeal,
    identity,
    attestation,
    delegation,
    escrow,
    vault,
    advert,
    legacy,
  };
}
