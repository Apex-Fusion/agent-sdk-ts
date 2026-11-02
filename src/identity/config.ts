/**
 * Deployment values and endpoints of the identity registry (Part 2 §2, §11).
 *
 * Two values are free: the allowlist root (`VECTOR_IDENTITY_LEGACY_ROOT`)
 * and the seed of `config_seal` (`VECTOR_IDENTITY_CONFIG_SEED`). Every script
 * hash follows from them and the legacy hash (`deriveIdentityDeployment`).
 * `VECTOR_IDENTITY_POLICY_ID`, when set, must equal the derived identity
 * policy ID. The environment names are the same as in the Python SDK.
 */
import {
  DEFAULT_IDENTITY_GATEWAY_URL,
  DEFAULT_KOIOS_URL,
  DEFAULT_OGMIOS_URL,
  DEFAULT_SUBMIT_URL,
  REGISTRY_POLICY_ID,
} from '../constants.js';
import { IdentityConfigError } from './errors.js';
import type { OutputReference } from './vendor.js';

/** The environment variable of each configuration field. */
export const IDENTITY_ENV_VARS = {
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

/** Input of `identityConfig`: references may be `<tx id>#<index>` text. */
export type IdentityConfigInput = {
  [K in keyof IdentityConfig]?: K extends ReferenceField ? OutputReference | string | null : IdentityConfig[K];
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
 * environment wins over the defaults (Vector mainnet endpoints and the
 * public gateway). Values are checked here; a missing deployment value is
 * reported only when a transaction needs it.
 */
export function identityConfig(
  overrides: IdentityConfigInput = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): IdentityConfig {
  const read = (field: IdentityConfigField): string | null => {
    const raw = env[IDENTITY_ENV_VARS[field]]?.trim();
    return raw ? raw : null;
  };
  const text = <K extends IdentityConfigField>(field: K): IdentityConfigInput[K] | string | null =>
    overrides[field] !== undefined ? overrides[field] : read(field);
  const optionalRef = (field: ReferenceField): OutputReference | null => {
    const value = text(field);
    return value === null || value === undefined ? null : reference(field, value as OutputReference | string);
  };
  const optionalHex = (field: 'legacyRoot' | 'identityPolicyId', bytes: number): string | null => {
    const value = text(field);
    return value === null || value === undefined ? null : parseHex(field, String(value), bytes);
  };
  const url = (field: 'gatewayUrl' | 'ogmiosUrl' | 'submitUrl' | 'koiosUrl', fallback: string): string =>
    String(text(field) ?? fallback).trim().replace(/\/+$/, '');
  const legacyHash = text('legacyHash');
  const koiosToken = text('koiosToken');
  const indexerUrl = text('indexerUrl');
  return {
    legacyRoot: optionalHex('legacyRoot', 32),
    configSeed: optionalRef('configSeed'),
    legacyHash: legacyHash === null || legacyHash === undefined ? REGISTRY_POLICY_ID : parseHex('legacyHash', String(legacyHash), 28),
    identityPolicyId: optionalHex('identityPolicyId', 28),
    identityRef: optionalRef('identityRef'),
    attestationRef: optionalRef('attestationRef'),
    delegationRef: optionalRef('delegationRef'),
    vaultRef: optionalRef('vaultRef'),
    legacyRef: optionalRef('legacyRef'),
    module1Ref: optionalRef('module1Ref'),
    configUtxo: optionalRef('configUtxo'),
    gatewayUrl: url('gatewayUrl', DEFAULT_IDENTITY_GATEWAY_URL),
    ogmiosUrl: url('ogmiosUrl', DEFAULT_OGMIOS_URL),
    submitUrl: url('submitUrl', DEFAULT_SUBMIT_URL),
    koiosUrl: url('koiosUrl', DEFAULT_KOIOS_URL),
    koiosToken: koiosToken ? String(koiosToken) : null,
    indexerUrl: indexerUrl ? String(indexerUrl).trim().replace(/\/+$/, '') : null,
  };
}
