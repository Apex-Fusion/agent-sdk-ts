// Identity registry support (did:vector): clients over the vendored
// agents-marketplace builders. See README "Identity registry".

import { Attestations } from './attestations.js';
import { IdentityContext, type IdentityContextOptions } from './context.js';
import { Delegations } from './delegations.js';
import type { IdentityGateway } from './gateway.js';
import { IdentityRegistry } from './registry.js';
import { Vaults, type AdvertListed } from './vaults.js';

export { IDENTITY_ENV_VARS, identityConfig, parseOutputReference } from './config.js';
export type { IdentityConfig, IdentityConfigField, IdentityConfigInput } from './config.js';
export { IdentityConfigError, IdentityLookupError, IdentityRuleError } from './errors.js';
export {
  builderProtocolParameters,
  DEFAULT_VALID_FOR_SECONDS,
  IdentityContext,
  WINDOW_BACKPAD_MS,
} from './context.js';
export type { AuthenticOutput, BuildOptions, IdentityContextOptions } from './context.js';
export { applyScriptParameters, blueprintScript, deriveIdentityDeployment } from './scripts.js';
export type { AppliedScript, IdentityDeployment } from './scripts.js';
export {
  AgentView,
  DidResolution,
  DidResolutionError,
  DOCUMENT_MEDIA_TYPE,
  formatVersionTime,
  IdentityGateway,
  RESOLUTION_MEDIA_TYPE,
} from './gateway.js';
export type { IdentityGatewayOptions, ResolvedKey, ResolveOptions } from './gateway.js';
export { CONTROLLER_SET, IdentityRegistry, keyHashSigner, module1Signer, PartySpec } from './registry.js';
export type { AdoptOptions, PartySpecInit, RegisterOptions, SpendOptions, UpdateOptions } from './registry.js';
export {
  Attestations,
  didKey,
  envelopeProtectedHeader,
  envelopeSigStructure,
  verifyEnvelope,
  withdrawable,
} from './attestations.js';
export type { AttestationActionOptions, AttestOptions } from './attestations.js';
export { agentDelegator, Delegations, principalKeyDelegator } from './delegations.js';
export type { DelegateOptions, DelegationUseInputs } from './delegations.js';
export { NETWORK_BUFFER_MS, requestSpecHash, Vaults } from './vaults.js';
export type { AdvertListed, VaultJob, VaultOutput } from './vaults.js';
export { addVKeyWitnesses, missingSigners, signTransaction, transactionId, witnessKeyHashes } from './signing.js';
export { toVectorId } from './ids.js';

// Builder-level API and codecs of the vendored agents-marketplace code (unchanged).
export {
  activeKey,
  allowlistProof,
  allowlistRoot,
  buildAllowlistTree,
  createP256Pop,
  decodeAttestationDatum,
  decodeDelegationDatum,
  decodeIdentityAdvertDatum,
  decodeIdentityEscrowDatum,
  decodeIdentityDatum,
  decodeLegacyDatum,
  decodeVaultDatum,
  dnsSafe,
  ed25519Key,
  effectiveStatus,
  encodeIdentityDatum,
  escrowResource,
  HIRE_ACTION,
  keyHash,
  legacyProfile,
  legacyVectorDid,
  p256Key,
  p256PopMessage,
  parseVectorDid,
  patternCovers,
  PURPOSE_ASSERTION,
  PURPOSE_AUTHENTICATION,
  PURPOSE_DELEGATION,
  PURPOSE_TRANSACTION,
  RECORD_DEPOSIT,
  REVOKE_REASONS,
  RIGHT_RECOVER,
  RIGHT_REVOKE,
  RIGHT_SUSPEND,
  ROLE_MAX_RIGHTS,
  SUSPEND_REASONS,
  TxConstructionError,
  utf8FromHex,
  utf8ToHex,
  validityWindow,
  vectorDid,
  vectorIdFromSeed,
  verifyAllowlistProof,
  verifyP256Pop,
  VECTOR_MAINNET_SLOT_CONFIG,
} from './vendor.js';
export type {
  Actor,
  Anchor,
  AttestationContent,
  AttestationDatum,
  AttestTx,
  AttStatus,
  CreatedRecordTx,
  DelegateTx,
  DelegationDatum,
  DelegationUtxo,
  Delegator,
  EffectiveStatus,
  ExUnits,
  Hold,
  IdentityDatum,
  IssuerAuthority,
  Key,
  KeyType,
  LegacyDatum,
  Lineage,
  Link,
  OutputReference,
  ParsedVectorDid,
  Party,
  PendingRecovery,
  Profile,
  ProtocolParameters as IdentityProtocolParameters,
  RecordUtxo,
  Role,
  ScriptSource,
  Signer,
  SlotConfig,
  Status,
  TxContext,
  UnsignedTx,
  Utxo as ChainUtxo,
  ValidityWindow,
  ValueLimit,
  VaultDatum,
  VaultEscrowJob,
} from './vendor.js';

/** Every identity client on one context. */
export interface IdentityClients {
  context: IdentityContext;
  registry: IdentityRegistry;
  attestations: Attestations;
  delegations: Delegations;
  vaults: Vaults;
  gateway: IdentityGateway;
}

/** The identity clients on a context (default: a context from the environment). */
export function createIdentityClients(
  context: IdentityContext | IdentityContextOptions = {},
  options: { advertListed?: AdvertListed } = {},
): IdentityClients {
  const ctx = context instanceof IdentityContext ? context : new IdentityContext(context);
  return {
    context: ctx,
    registry: new IdentityRegistry(ctx),
    attestations: new Attestations(ctx),
    delegations: new Delegations(ctx),
    vaults: new Vaults(ctx, options.advertListed === undefined ? {} : { advertListed: options.advertListed }),
    gateway: ctx.gateway,
  };
}
