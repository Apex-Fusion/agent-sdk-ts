// One import point for the vendored agents-marketplace code (see VENDORED-FROM.md).
// The vendored files stay unchanged; `scripts/sync-identity.mjs` replaces them.

export * from '../vendor/agents-marketplace/packages/shared/src/identity/tx/index.js';
export * from '../vendor/agents-marketplace/packages/shared/src/identity/index.js';
export type { OutputReference, Utxo } from '../vendor/agents-marketplace/packages/shared/src/chain/ChainProvider.js';
export type { NetworkId } from '../vendor/agents-marketplace/packages/shared/src/network.js';
export {
  bytesToHex,
  decodePlutusDataHex,
  encodePlutusData,
  encodePlutusDataHex,
  hexToBytes,
  type PlutusData,
} from '../vendor/agents-marketplace/packages/shared/src/cbor/plutus-data.js';
export {
  decodeIdentityDatum,
  decodeLegacyDatum,
  encodeIdentityDatum,
  KEY_TYPES,
  ROLES,
  type Hold,
  type IdentityDatum,
  type Key,
  type KeyType,
  type LegacyDatum,
  type Lineage,
  type Party,
  type PendingRecovery,
  type Role,
  type Signer,
  type Status,
} from '../vendor/agents-marketplace/packages/shared/src/cbor/IdentityDatum.js';
export type { Actor, IdentityMint, IdentitySpend } from '../vendor/agents-marketplace/packages/shared/src/cbor/IdentityRedeemer.js';
export {
  decodeAttestationDatum,
  encodeAttestationDatum,
  type Anchor,
  type AttestationDatum,
  type AttStatus,
  type Link,
} from '../vendor/agents-marketplace/packages/shared/src/cbor/Attestation.js';
export {
  decodeDelegationDatum,
  decodeVaultDatum,
  encodeDelegationDatum,
  encodeVaultDatum,
  type DelegationDatum,
  type Delegator,
  type ValueLimit,
  type VaultDatum,
} from '../vendor/agents-marketplace/packages/shared/src/cbor/Delegation.js';
export {
  decodeIdentityAdvertDatum,
  encodeIdentityAdvertDatum,
  type IdentityAdvertDatum,
} from '../vendor/agents-marketplace/packages/shared/src/cbor/IdentityAdvertDatum.js';
export {
  decodeIdentityEscrowDatum,
  type IdentityEscrowDatum,
  type Refund,
} from '../vendor/agents-marketplace/packages/shared/src/cbor/IdentityEscrowDatum.js';
export {
  blake2b224Hex,
  blake2b256Hex,
  compareOutRefs,
  isEnterpriseAddressOf,
  rewardAddressBytes,
  utxoAssets,
} from '../vendor/agents-marketplace/packages/shared/src/identity/tx/ledger.js';
export { cborArray, cborBytes, cborInt, cborMap, cborUint, concatBytes, readCbor } from '../vendor/agents-marketplace/packages/shared/src/identity/tx/cbor.js';
export { canonicalize } from '../vendor/agents-marketplace/packages/shared/src/cbor/canonical.js';
export {
  accountable,
  covers,
  datumMap,
  hasRight,
  hasScriptParty,
  partyEquals,
  sameParty,
  sameSigner,
  terminal,
} from '../vendor/agents-marketplace/packages/shared/src/identity/tx/records.js';
