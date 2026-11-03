/**
 * Deployment values and endpoints of the identity registry (Part 2 §2, §10, §11).
 *
 * Two values are free: the allowlist root (`VECTOR_IDENTITY_LEGACY_ROOT`)
 * and the seed of `config_seal` (`VECTOR_IDENTITY_CONFIG_SEED`). Every script
 * hash follows from them and the legacy hash (`deriveIdentityDeployment`).
 * `VECTOR_IDENTITY_POLICY_ID`, when set, must equal the derived identity
 * policy ID. The environment names are the same as in the Python SDK.
 *
 * Mainnet is the default network (`VECTOR_IDENTITY_NETWORK`). On mainnet,
 * unset deployment values take the published values of
 * `MAINNET_IDENTITY_DEPLOYMENT`. The testnet has no published values.
 */
import {
  DEFAULT_IDENTITY_GATEWAY_URL,
  DEFAULT_KOIOS_URL,
  DEFAULT_OGMIOS_URL,
  DEFAULT_SUBMIT_URL,
  REGISTRY_POLICY_ID,
} from '../constants.js';
import { trimTrailingSlashes } from '../utils.js';
import { IdentityConfigError } from './errors.js';
import type { OutputReference } from './vendor.js';

/**
 * The network of `identityConfig`. Both Vector networks use network ID 1, so
 * only this name selects the published deployment values.
 */
export type IdentityNetwork = 'mainnet' | 'testnet';

const output = (txHash: string, index: number): Readonly<OutputReference> => Object.freeze({ txHash, index });

/**
 * The published identity deployment on Vector mainnet (the identity side,
 * 2026-11-03): agents-marketplace 4c95c3f,
 * `contracts/identity-marketplace/deploy/mainnet/deployment.json`. On mainnet,
 * `identityConfig` uses these values for unset fields. The clients of this
 * SDK do not spend `escrow` or `advert`; their reference outputs are here for
 * other callers. The Module-1 values (M1, its reference output and the
 * configuration record) come with the seal.
 */
export const MAINNET_IDENTITY_DEPLOYMENT = Object.freeze({
  legacyHash: 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01',
  legacyRoot: 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01',
  configSeed: output('6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a', 0),
  identityPolicyId: 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762',
  identityRef: output('3d4471222e524584180a4358e05517a243effc46d15ef62443a82aaed822de46', 0),
  attestationRef: output('55dfa9e05ff96844fd4313f1c7cb7f0c7f900f1cdf50099b0e2abb242da4128d', 0),
  delegationRef: output('f6d47a62146b2bc4dabc12454c8a3dbbedf673d45a6edccd1c462d55c8ba8be7', 0),
  vaultRef: output('d0bf8f73c915fcbf57ddba714256e520a9a0820bc9e643218db8cf54762d215b', 0),
  escrowRef: output('4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82', 0),
  advertRef: output('5efd18a1d90a6b87f1fd4b6fe93acfbe5be082260fd52be194b1088ade7c2758', 0),
});

/** The environment variable of each setting of `identityConfig`. */
export const IDENTITY_ENV_VARS = {
  network: 'VECTOR_IDENTITY_NETWORK',
  legacyRoot: 'VECTOR_IDENTITY_LEGACY_ROOT',
  configSeed: 'VECTOR_IDENTITY_CONFIG_SEED',
  legacyHash: 'VECTOR_IDENTITY_LEGACY_HASH',
  identityPolicyId: 'VECTOR_IDENTITY_POLICY_ID',
  identityRef: 'VECTOR_IDENTITY_REF_UTXO',
  attestationRef: 'VECTOR_ATTESTATION_REF_UTXO',
  delegationRef: 'VECTOR_DELEGATION_REF_UTXO',
  vaultRef: 'VECTOR_VAULT_REF_UTXO',
  legacyRef: 'VECTOR_LEGACY_REGISTRY_REF_UTXO',
  module1Ref: 'VECTOR_MODULE1_REF_UTXO',
  configUtxo: 'VECTOR_IDENTITY_CONFIG_UTXO',
  gatewayUrl: 'VECTOR_IDENTITY_GATEWAY_URL',
  ogmiosUrl: 'VECTOR_OGMIOS_URL',
  submitUrl: 'VECTOR_SUBMIT_URL',
  koiosUrl: 'VECTOR_KOIOS_URL',
  koiosToken: 'VECTOR_KOIOS_TOKEN',
  indexerUrl: 'VECTOR_MARKETPLACE_INDEXER_URL',
} as const;

export type IdentityConfigField = keyof typeof IDENTITY_ENV_VARS;

/** Fields that name an output as `<tx id>#<index>`. */
const REFERENCE_FIELDS = [
  'configSeed', 'identityRef', 'attestationRef', 'delegationRef', 'vaultRef', 'legacyRef', 'module1Ref', 'configUtxo',
] as const;
type ReferenceField = (typeof REFERENCE_FIELDS)[number];

export interface IdentityConfig {
  /** The allowlist Merkle root (32 bytes, hex), an `identity` parameter. */
  legacyRoot: string | null;
  /** The output that `config_seal` is bound to (its first parameter). */
  configSeed: OutputReference | null;
  /** The legacy registry hash (default `be1a0a29…`, Part 2 §2). */
  legacyHash: string;
  /** Optional cross-check: the identity policy ID of the deployment. */
  identityPolicyId: string | null;
  /** Reference-script outputs. Without one, a transaction carries the script itself. */
  identityRef: OutputReference | null;
  attestationRef: OutputReference | null;
  delegationRef: OutputReference | null;
  vaultRef: OutputReference | null;
  legacyRef: OutputReference | null;
  /** The reference script of Module-1 `identity_party`; needed for a Module-1 consent. */
  module1Ref: OutputReference | null;
  /** The configuration record (Part 2 §3.8); default: found at the `config_holder` address. */
  configUtxo: OutputReference | null;
  gatewayUrl: string;
  ogmiosUrl: string;
  submitUrl: string;
  koiosUrl: string;
  koiosToken: string | null;
  /** The marketplace indexer; `Vaults.pay` reads the advert listing from it. */
  indexerUrl: string | null;
}

/** Input of `identityConfig`: references may be `<tx id>#<index>` text. `null` sets no value and no default. */
export type IdentityConfigInput = {
  [K in keyof IdentityConfig]?: K extends ReferenceField ? OutputReference | string | null : IdentityConfig[K];
} & {
  /** `mainnet` (default) or `testnet`: the network whose published deployment values fill unset fields. */
  network?: IdentityNetwork;
};

function parseHex(field: IdentityConfigField, value: string, bytes: number): string {
  const text = value.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new IdentityConfigError(`${IDENTITY_ENV_VARS[field]}: expected ${bytes * 2} hexadecimal characters`);
  }
  return text;
}

/** `<tx id>#<index>` as an output reference. */
export function parseOutputReference(value: string, label = 'output reference'): OutputReference {
  const match = /^([0-9a-f]{64})#(\d{1,6})$/.exec(value.trim().toLowerCase());
  if (match === null) throw new IdentityConfigError(`${label}: expected <tx id>#<index>`);
  return { txHash: match[1]!, index: Number(match[2]) };
}

function reference(field: ReferenceField, value: OutputReference | string): OutputReference {
  if (typeof value === 'string') return parseOutputReference(value, IDENTITY_ENV_VARS[field]);
  if (!/^[0-9a-f]{64}$/.test(value.txHash) || !Number.isSafeInteger(value.index) || value.index < 0) {
    throw new IdentityConfigError(`${IDENTITY_ENV_VARS[field]}: not an output reference`);
  }
  return { txHash: value.txHash, index: value.index };
}

/**
 * The identity configuration: `overrides` win over the environment, and the
 * environment wins over the defaults: the Vector mainnet endpoints, the
 * public gateway and, on mainnet, the published deployment
 * (`MAINNET_IDENTITY_DEPLOYMENT`). The published root and seed apply together,
 * and only when neither value is set. The published policy ID and reference
 * outputs apply only when the legacy hash, the root and the seed are the
 * published values. Values are checked here; a missing deployment value is
 * reported only when a transaction needs it.
 */
export function identityConfig(
  overrides: IdentityConfigInput = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): IdentityConfig {
  /** The override, else the environment; `undefined` when neither sets the field. */
  const given = (field: IdentityConfigField): unknown => {
    if (overrides[field] !== undefined) return overrides[field];
    const raw = env[IDENTITY_ENV_VARS[field]]?.trim();
    return raw ? raw : undefined;
  };
  const optionalRef = (field: ReferenceField, fallback: Readonly<OutputReference> | null = null): OutputReference | null => {
    const value = given(field);
    if (value === undefined) return fallback === null ? null : { txHash: fallback.txHash, index: fallback.index };
    return value === null ? null : reference(field, value as OutputReference | string);
  };
  const optionalHex = (field: 'legacyRoot' | 'identityPolicyId', bytes: number, fallback: string | null = null): string | null => {
    const value = given(field);
    if (value === undefined) return fallback;
    return value === null ? null : parseHex(field, String(value), bytes);
  };
  const url = (field: 'gatewayUrl' | 'ogmiosUrl' | 'submitUrl' | 'koiosUrl', fallback: string): string =>
    trimTrailingSlashes(String(given(field) ?? fallback).trim());
  const network = String(given('network') ?? 'mainnet').trim().toLowerCase();
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new IdentityConfigError(`${IDENTITY_ENV_VARS.network}: expected mainnet or testnet`);
  }
  const legacyHashValue = given('legacyHash');
  const legacyHash = legacyHashValue === null || legacyHashValue === undefined
    ? REGISTRY_POLICY_ID
    : parseHex('legacyHash', String(legacyHashValue), 28);
  const defaults = network === 'mainnet' && legacyHash === MAINNET_IDENTITY_DEPLOYMENT.legacyHash ? MAINNET_IDENTITY_DEPLOYMENT : null;
  const pair = given('legacyRoot') === undefined && given('configSeed') === undefined ? defaults : null;
  const legacyRoot = optionalHex('legacyRoot', 32, pair?.legacyRoot ?? null);
  const configSeed = optionalRef('configSeed', pair?.configSeed ?? null);
  const published = defaults !== null && legacyRoot === defaults.legacyRoot && configSeed !== null
    && configSeed.txHash === defaults.configSeed.txHash && configSeed.index === defaults.configSeed.index
    ? defaults
    : null;
  const koiosToken = given('koiosToken');
  const indexerUrl = given('indexerUrl');
  return {
    legacyRoot,
    configSeed,
    legacyHash,
    identityPolicyId: optionalHex('identityPolicyId', 28, published?.identityPolicyId ?? null),
    identityRef: optionalRef('identityRef', published?.identityRef ?? null),
    attestationRef: optionalRef('attestationRef', published?.attestationRef ?? null),
    delegationRef: optionalRef('delegationRef', published?.delegationRef ?? null),
    vaultRef: optionalRef('vaultRef', published?.vaultRef ?? null),
    legacyRef: optionalRef('legacyRef'),
    module1Ref: optionalRef('module1Ref'),
    configUtxo: optionalRef('configUtxo'),
    gatewayUrl: url('gatewayUrl', DEFAULT_IDENTITY_GATEWAY_URL),
    ogmiosUrl: url('ogmiosUrl', DEFAULT_OGMIOS_URL),
    submitUrl: url('submitUrl', DEFAULT_SUBMIT_URL),
    koiosUrl: url('koiosUrl', DEFAULT_KOIOS_URL),
    koiosToken: koiosToken ? String(koiosToken) : null,
    indexerUrl: indexerUrl ? trimTrailingSlashes(String(indexerUrl).trim()) : null,
  };
}
