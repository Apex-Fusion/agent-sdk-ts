// ─── Configuration ──────────────────────────────────────────────────

export interface VectorAgentConfig {
  ogmiosUrl?: string;
  submitUrl?: string;
  koiosUrl?: string;
  mnemonic?: string;
  skeyPath?: string;
  skeyCborHex?: string;
  accountIndex?: number;
  spendLimitPerTx?: number;
  spendLimitDaily?: number;
  explorerUrl?: string;
  auditLogPath?: string;
  rateLimitPerMinute?: number;
}

// ─── Balance ────────────────────────────────────────────────────────

export interface TokenBalance {
  policyId: string;
  assetName: string;
  quantity: string;
}

export interface VectorBalance {
  address: string;
  ada: string;
  lovelace: bigint;
  tokens: TokenBalance[];
}

// ─── Transaction Results ────────────────────────────────────────────

export interface TxResult {
  txHash: string;
  sender: string;
  recipient: string;
  amountLovelace: number;
  explorerUrl: string;
}

export interface TokenTxResult extends TxResult {
  policyId: string;
  assetName: string;
  tokenQuantity: string;
}

// ─── Spend Limits ───────────────────────────────────────────────────

export interface SpendLimits {
  perTransaction: number;
  daily: number;
}

export interface SpendStatus {
  perTransactionLimit: number;
  dailyLimit: number;
  dailySpent: number;
  dailyRemaining: number;
  resetTime: string;
}

export interface AuditEntry {
  timestamp: string;
  txHash: string;
  amountLovelace: number;
  recipient: string;
  action: string;
}

// ─── Build Transaction ──────────────────────────────────────────────

export interface TxOutput {
  address: string;
  lovelace: number;
  assets?: Record<string, string>;
}

export interface BuildTxResult {
  txCbor: string;
  txHash: string;
  feeLovelace: number;
  feeAda: string;
  outputCount: number;
  submitted: boolean;
  explorerUrl?: string;
}

// ─── Dry Run ────────────────────────────────────────────────────────

export interface DryRunResult {
  valid: boolean;
  feeLovelace: number;
  feeAda: string;
  executionUnits?: { memory: number; cpu: number };
  error?: string;
}

// ─── Transaction History ────────────────────────────────────────────

export interface TxSummary {
  txHash: string;
  blockHeight: number;
  blockTime: string;
  fee: string;
}

// ─── Deploy Contract ────────────────────────────────────────────────

export interface DeployContractResult extends TxResult {
  scriptAddress: string;
  scriptHash: string;
  scriptType: string;
}

// ─── Interact Contract ──────────────────────────────────────────────

export interface InteractContractResult extends TxResult {
  scriptAddress: string;
  action: 'spend' | 'lock';
}

// ─── Agent Registry ─────────────────────────────────────────────────

export interface AgentProfile {
  agentId: string;
  name: string;
  description: string;
  capabilities: string[];
  framework: string;
  endpoint: string;
  registeredAt: number;
  utxoRef?: string;
  ownerVkeyHash?: string;
}

export interface AgentRegistrationResult {
  agentId: string;
  nftAssetName: string;
  txHash: string;
  explorerUrl: string;
}

export interface AgentUpdateResult {
  agentId: string;
  txHash: string;
  updatedFields: string[];
  explorerUrl: string;
}

export interface AgentDeregistrationResult {
  agentId: string;
  txHash: string;
  depositReturned: string;
  explorerUrl: string;
}

export interface AgentTransferResult {
  agentId: string;
  txHash: string;
  newOwnerAddress: string;
  explorerUrl: string;
}

export interface AgentMessageResult {
  txHash: string;
  recipientAddress: string;
  messageType: string;
  explorerUrl: string;
}
