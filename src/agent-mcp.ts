/**
 * IVectorAgentMCP — MCP client mode interface (not yet implemented).
 *
 * When implemented, this class will connect to the Vector MCP server
 * (vector-mcp-server) via stdio and delegate all operations.
 *
 * For now, use VectorAgent (standalone mode) which talks directly to
 * Ogmios and the submit API.
 */
import type {
  VectorBalance, TxResult, TokenTxResult, TxOutput, BuildTxResult,
  DryRunResult, TxSummary, SpendStatus,
  DeployContractResult, InteractContractResult,
  AgentProfile, AgentRegistrationResult, AgentUpdateResult,
  AgentDeregistrationResult, AgentTransferResult, AgentMessageResult,
} from './types.js';

export interface IVectorAgentMCP {
  // Lifecycle
  connect(): Promise<void>;
  close(): Promise<void>;

  // Queries
  getAddress(): Promise<string>;
  getBalance(address?: string): Promise<VectorBalance>;
  getUtxos(address?: string): Promise<any[]>;
  getSpendLimits(): Promise<SpendStatus>;

  // Transactions
  send(params: { to: string; lovelace?: number; ada?: number; metadata?: Record<number, any> }): Promise<TxResult>;
  sendTokens(params: { to: string; policyId: string; assetName: string; quantity: number | string; ada?: number }): Promise<TokenTxResult>;
  dryRun(params: { to: string; lovelace?: number; ada?: number }): Promise<DryRunResult>;
  buildTransaction(params: { outputs: TxOutput[]; metadata?: Record<number, any>; submit?: boolean }): Promise<BuildTxResult>;
  getTransactionHistory(params?: { address?: string; limit?: number; offset?: number }): Promise<TxSummary[]>;

  // Contracts
  deployContract(params: { scriptCbor: string; scriptType?: string; initialDatum?: string; lovelace?: number }): Promise<DeployContractResult>;
  interactContract(params: { scriptCbor: string; scriptType?: string; action?: 'spend' | 'lock'; redeemer?: string; datum?: string; lovelace?: number; utxoRef?: { txHash: string; outputIndex: number } }): Promise<InteractContractResult>;

  // Registry
  registerAgent(params: { name: string; description: string; capabilities: string[]; framework: string; endpoint: string }): Promise<AgentRegistrationResult>;
  discoverAgents(params?: { capability?: string; framework?: string; limit?: number }): Promise<AgentProfile[]>;
  getAgentProfile(agentId: string): Promise<AgentProfile>;
  updateAgent(agentId: string, updates: Record<string, any>): Promise<AgentUpdateResult>;
  deregisterAgent(agentId: string): Promise<AgentDeregistrationResult>;
  transferAgent(agentId: string, newOwnerAddress: string): Promise<AgentTransferResult>;
  messageAgent(agentId: string, params: { type: string; payload: string }): Promise<AgentMessageResult>;
}
