// Main classes
export { VectorAgent } from './agent.js';
export type { IVectorAgentMCP } from './agent-mcp.js';

// Types
export type {
  VectorAgentConfig,
  VectorBalance, TokenBalance, TxResult, TokenTxResult,
  SpendStatus, SpendLimits, AuditEntry,
  TxOutput, BuildTxResult, DryRunResult, TxSummary,
  DeployContractResult, InteractContractResult,
  AgentProfile, AgentRegistrationResult, AgentUpdateResult,
  AgentDeregistrationResult, AgentTransferResult, AgentMessageResult,
} from './types.js';

// Errors
export {
  VectorError, ConnectionError, InsufficientFundsError,
  SpendLimitExceededError, TransactionError, WalletError,
  InvalidAddressError, RegistryError,
} from './errors.js';

// Sub-modules for advanced users
export { OgmiosProvider } from './chain/ogmios-provider.js';
export type { OgmiosProviderConfig } from './chain/ogmios-provider.js';
export { SafetyLayer } from './safety/safety-layer.js';
export { RateLimiter } from './safety/rate-limiter.js';
export { HDWallet } from './wallet/hd-wallet.js';
export { SkeyWallet } from './wallet/skey-wallet.js';
export type { WalletAdapter } from './wallet/types.js';
export { AgentRegistry } from './registry/agent-registry.js';

// Registry helpers
export {
  deriveNftAssetName, buildAgentDatum, parseAgentDatum,
  parseDid, getRegistryAddress, getRegistryScriptHash,
} from './registry/helpers.js';

// Utilities
export { lovelaceToAda, explorerTxLink, metadataStr, formatAssetName } from './utils.js';

// Constants
export {
  REGISTRY_POLICY_ID, MIN_AP3X_DEPOSIT, AGENT_MESSAGE_LABEL,
  DEFAULT_OGMIOS_URL, DEFAULT_SUBMIT_URL, DEFAULT_KOIOS_URL, DEFAULT_EXPLORER_URL,
  DEFAULT_PER_TX_LIMIT, DEFAULT_DAILY_LIMIT,
} from './constants.js';
