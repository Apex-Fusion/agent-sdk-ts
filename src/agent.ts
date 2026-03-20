// @ts-nocheck
// VectorAgent — main orchestrator class for the Vector Agent SDK.
// @ts-nocheck needed because Lucid's Data/Constr types and some internal APIs are dynamically typed.

import { Lucid, fromText, Data, applyDoubleCborEncoding, validatorToAddress, validatorToScriptHash, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, SpendingValidator } from '@lucid-evolution/lucid';
import { OgmiosProvider } from './chain/ogmios-provider.js';
import { SafetyLayer } from './safety/safety-layer.js';
import { RateLimiter } from './safety/rate-limiter.js';
import { HDWallet } from './wallet/hd-wallet.js';
import { SkeyWallet } from './wallet/skey-wallet.js';
import { AgentRegistry } from './registry/agent-registry.js';
import type { WalletAdapter } from './wallet/types.js';
import {
  VectorError, TransactionError, InvalidAddressError,
} from './errors.js';
import {
  DEFAULT_OGMIOS_URL, DEFAULT_SUBMIT_URL, DEFAULT_KOIOS_URL,
  DEFAULT_EXPLORER_URL, DEFAULT_PER_TX_LIMIT, DEFAULT_DAILY_LIMIT,
} from './constants.js';
import { lovelaceToAda, explorerTxLink, formatAssetName } from './utils.js';
import type {
  VectorAgentConfig, VectorBalance, TokenBalance,
  TxResult, TokenTxResult, TxOutput, BuildTxResult,
  DryRunResult, TxSummary, SpendStatus,
  DeployContractResult, InteractContractResult,
  AgentProfile, AgentRegistrationResult, AgentUpdateResult,
  AgentDeregistrationResult, AgentTransferResult, AgentMessageResult,
} from './types.js';

export class VectorAgent {
  private readonly provider: OgmiosProvider;
  private readonly wallet: WalletAdapter;
  private readonly safety: SafetyLayer;
  private readonly rateLimiter: RateLimiter;
  private readonly explorerUrl: string;
  private readonly registry: AgentRegistry;
  private lucid: LucidEvolution | null = null;

  constructor(config: VectorAgentConfig = {}) {
    const ogmiosUrl = config.ogmiosUrl ?? process.env.VECTOR_OGMIOS_URL ?? DEFAULT_OGMIOS_URL;
    const submitUrl = config.submitUrl ?? process.env.VECTOR_SUBMIT_URL ?? DEFAULT_SUBMIT_URL;
    const koiosUrl = config.koiosUrl ?? process.env.VECTOR_KOIOS_URL ?? DEFAULT_KOIOS_URL;
    this.explorerUrl = config.explorerUrl ?? process.env.VECTOR_EXPLORER_URL ?? DEFAULT_EXPLORER_URL;

    if (!ogmiosUrl) throw new VectorError('ogmiosUrl required (or set VECTOR_OGMIOS_URL)');
    if (!submitUrl) throw new VectorError('submitUrl required (or set VECTOR_SUBMIT_URL)');

    this.provider = new OgmiosProvider({ ogmiosUrl, submitUrl, koiosUrl });

    // Wallet
    const mnemonic = config.mnemonic ?? process.env.VECTOR_MNEMONIC;
    const skeyPath = config.skeyPath ?? process.env.VECTOR_SKEY_PATH;
    const skeyCborHex = config.skeyCborHex;
    const accountIndex = config.accountIndex ?? parseInt(process.env.VECTOR_ACCOUNT_INDEX ?? '0');

    if (mnemonic) {
      this.wallet = new HDWallet(mnemonic, accountIndex);
    } else if (skeyPath) {
      this.wallet = SkeyWallet.fromFile(skeyPath);
    } else if (skeyCborHex) {
      this.wallet = SkeyWallet.fromCborHex(skeyCborHex);
    } else {
      throw new VectorError(
        'Provide mnemonic, skeyPath, or skeyCborHex (or set VECTOR_MNEMONIC / VECTOR_SKEY_PATH)'
      );
    }

    // Safety
    const perTx = config.spendLimitPerTx
      ?? parseInt(process.env.VECTOR_SPEND_LIMIT_PER_TX ?? String(DEFAULT_PER_TX_LIMIT));
    const daily = config.spendLimitDaily
      ?? parseInt(process.env.VECTOR_SPEND_LIMIT_DAILY ?? String(DEFAULT_DAILY_LIMIT));
    this.safety = new SafetyLayer(perTx, daily, config.auditLogPath);

    this.rateLimiter = new RateLimiter(config.rateLimitPerMinute ?? 60);
    this.registry = new AgentRegistry(this.provider, this.safety, this.explorerUrl);
  }

  // ─── Lucid Initialization (lazy) ──────────────────────────────────

  private async ensureLucid(): Promise<LucidEvolution> {
    if (!this.lucid) {
      this.lucid = await Lucid(this.provider, 'Mainnet');
      this.wallet.selectWallet(this.lucid);
    }
    return this.lucid;
  }

  // ─── Properties ───────────────────────────────────────────────────

  get safetyLayer(): SafetyLayer { return this.safety; }

  // ─── Queries ──────────────────────────────────────────────────────

  async getAddress(): Promise<string> {
    const lucid = await this.ensureLucid();
    return lucid.wallet().address();
  }

  async getBalance(address?: string): Promise<VectorBalance> {
    const lucid = await this.ensureLucid();
    const queryAddress = address ?? await lucid.wallet().address();
    const utxos = await this.provider.getUtxos(queryAddress);

    const aggregated: Record<string, bigint> = {};
    for (const utxo of utxos) {
      for (const [unit, qty] of Object.entries(utxo.assets)) {
        aggregated[unit] = (aggregated[unit] || 0n) + BigInt(qty);
      }
    }

    const lovelace = aggregated['lovelace'] || 0n;
    const tokens: TokenBalance[] = [];
    for (const [unit, quantity] of Object.entries(aggregated)) {
      if (unit === 'lovelace') continue;
      const policyId = unit.slice(0, 56);
      const assetNameHex = unit.slice(56);
      tokens.push({
        policyId,
        assetName: assetNameHex ? formatAssetName(assetNameHex) : policyId.substring(0, 8) + '...',
        quantity: quantity.toString(),
      });
    }

    return {
      address: queryAddress,
      ada: lovelaceToAda(lovelace),
      lovelace,
      tokens,
    };
  }

  async getUtxos(address?: string): Promise<any[]> {
    const lucid = await this.ensureLucid();
    const queryAddress = address ?? await lucid.wallet().address();
    return this.provider.getUtxos(queryAddress);
  }

  async getProtocolParameters(): Promise<any> {
    return this.provider.getProtocolParameters();
  }

  async getSpendLimits(): Promise<SpendStatus> {
    return this.safety.getSpendStatus();
  }

  // ─── Transactions ─────────────────────────────────────────────────

  async send(params: {
    to: string;
    lovelace?: number;
    ada?: number;
    metadata?: Record<number, any>;
  }): Promise<TxResult> {
    const lucid = await this.ensureLucid();
    const senderAddress = await lucid.wallet().address();

    // Resolve amount
    let lovelaceAmount: number;
    if (params.lovelace) {
      lovelaceAmount = params.lovelace;
    } else if (params.ada) {
      lovelaceAmount = Math.floor(params.ada * 1_000_000);
    } else {
      throw new TransactionError('Provide either lovelace or ada amount');
    }

    // Validate recipient
    try {
      getAddressDetails(params.to);
    } catch {
      throw new InvalidAddressError(`Invalid recipient address: ${params.to}`);
    }

    // Safety check
    this.safety.enforceTransaction(lovelaceAmount);

    // Build TX
    let tx = lucid.newTx()
      .pay.ToAddress(params.to, { lovelace: BigInt(lovelaceAmount) });

    if (params.metadata) {
      for (const [label, value] of Object.entries(params.metadata)) {
        tx = tx.attachMetadata(Number(label), value);
      }
    }

    const signBuilder = await tx.complete();
    const signedTx = await signBuilder.sign.withWallet().complete();
    const txHash = await signedTx.submit();

    this.safety.recordTransaction(txHash, lovelaceAmount, params.to);

    return {
      txHash,
      sender: senderAddress,
      recipient: params.to,
      amountLovelace: lovelaceAmount,
      explorerUrl: explorerTxLink(this.explorerUrl, txHash),
    };
  }

  async sendTokens(params: {
    to: string;
    policyId: string;
    assetName: string;
    quantity: number | string;
    ada?: number;
  }): Promise<TokenTxResult> {
    const lucid = await this.ensureLucid();
    const senderAddress = await lucid.wallet().address();

    try {
      getAddressDetails(params.to);
    } catch {
      throw new InvalidAddressError(`Invalid recipient address: ${params.to}`);
    }

    // Encode asset name to hex if needed
    let assetNameHex = params.assetName;
    if (params.assetName && !/^[0-9a-fA-F]+$/.test(params.assetName)) {
      assetNameHex = fromText(params.assetName);
    }

    const unit = `${params.policyId}${assetNameHex}`;
    const outputLovelace = params.ada
      ? BigInt(Math.floor(params.ada * 1_000_000))
      : BigInt(2_000_000);

    this.safety.enforceTransaction(Number(outputLovelace));

    const tx = lucid.newTx()
      .pay.ToAddress(params.to, {
        lovelace: outputLovelace,
        [unit]: BigInt(params.quantity),
      });

    const signBuilder = await tx.complete();
    const signedTx = await signBuilder.sign.withWallet().complete();
    const txHash = await signedTx.submit();

    this.safety.recordTransaction(txHash, Number(outputLovelace), params.to);

    return {
      txHash,
      sender: senderAddress,
      recipient: params.to,
      amountLovelace: Number(outputLovelace),
      policyId: params.policyId,
      assetName: formatAssetName(assetNameHex),
      tokenQuantity: String(params.quantity),
      explorerUrl: explorerTxLink(this.explorerUrl, txHash),
    };
  }

  async dryRun(params: {
    to: string;
    lovelace?: number;
    ada?: number;
  }): Promise<DryRunResult> {
    const lucid = await this.ensureLucid();

    let lovelaceAmount: number;
    if (params.lovelace) {
      lovelaceAmount = params.lovelace;
    } else if (params.ada) {
      lovelaceAmount = Math.floor(params.ada * 1_000_000);
    } else {
      throw new TransactionError('Provide either lovelace or ada amount');
    }

    try {
      const tx = lucid.newTx()
        .pay.ToAddress(params.to, { lovelace: BigInt(lovelaceAmount) });

      const completedTx = await tx.complete();
      const txJson = (completedTx as any).toJSON?.() ?? {};
      const fee = String(txJson?.body?.fee ?? '0');
      const signedTx = await completedTx.sign.withWallet().complete();
      const cborHex = signedTx.toCBOR();

      let executionUnits: { memory: number; cpu: number } | undefined;
      try {
        const evalResult = await this.provider.evaluateTransaction(cborHex);
        if (Array.isArray(evalResult)) {
          let totalMemory = 0;
          let totalCpu = 0;
          for (const item of evalResult) {
            if (item.budget) {
              totalMemory += item.budget.memory || 0;
              totalCpu += item.budget.cpu || 0;
            }
          }
          if (totalMemory > 0 || totalCpu > 0) {
            executionUnits = { memory: totalMemory, cpu: totalCpu };
          }
        }
      } catch {
        // Evaluation unavailable — fee from building is still valid
      }

      return {
        valid: true,
        feeLovelace: Number(fee),
        feeAda: lovelaceToAda(fee),
        executionUnits,
      };
    } catch (err) {
      return {
        valid: false,
        feeLovelace: 0,
        feeAda: '0.000000',
        error: `Dry run failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async buildTransaction(params: {
    outputs: TxOutput[];
    metadata?: Record<number, any>;
    submit?: boolean;
  }): Promise<BuildTxResult> {
    if (!params.outputs || params.outputs.length === 0) {
      throw new TransactionError('At least one output is required');
    }

    const totalLovelace = params.outputs.reduce((sum, o) => sum + o.lovelace, 0);
    this.safety.enforceTransaction(totalLovelace);

    const lucid = await this.ensureLucid();
    let tx = lucid.newTx();

    for (const output of params.outputs) {
      const assets: Record<string, bigint> = { lovelace: BigInt(output.lovelace) };
      if (output.assets) {
        for (const [unit, qty] of Object.entries(output.assets)) {
          assets[unit] = BigInt(qty);
        }
      }
      tx = tx.pay.ToAddress(output.address, assets);
    }

    if (params.metadata) {
      for (const [label, value] of Object.entries(params.metadata)) {
        tx = tx.attachMetadata(Number(label), value);
      }
    }

    const completedTx = await tx.complete();
    const txJson = (completedTx as any).toJSON?.() ?? {};
    const fee = String(txJson?.body?.fee ?? '0');
    const txHash = completedTx.toHash();
    const txCbor = completedTx.toCBOR();

    if (params.submit) {
      const signedTx = await completedTx.sign.withWallet().complete();
      const submittedHash = await signedTx.submit();
      this.safety.recordTransaction(submittedHash, totalLovelace, params.outputs.map(o => o.address).join(', '));

      return {
        txCbor: '',
        txHash: submittedHash,
        feeLovelace: Number(fee),
        feeAda: lovelaceToAda(fee),
        outputCount: params.outputs.length,
        submitted: true,
        explorerUrl: explorerTxLink(this.explorerUrl, submittedHash),
      };
    }

    return {
      txCbor,
      txHash,
      feeLovelace: Number(fee),
      feeAda: lovelaceToAda(fee),
      outputCount: params.outputs.length,
      submitted: false,
    };
  }

  async getTransactionHistory(params?: {
    address?: string;
    limit?: number;
    offset?: number;
  }): Promise<TxSummary[]> {
    const lucid = await this.ensureLucid();
    const queryAddress = params?.address ?? await lucid.wallet().address();
    const txs = await this.provider.getTransactionHistory(queryAddress, params?.offset ?? 0, params?.limit ?? 20);

    return txs.map((tx: any) => ({
      txHash: tx.txHash,
      blockHeight: tx.blockHeight,
      blockTime: tx.blockTime,
      fee: tx.fee,
    }));
  }

  // ─── Smart Contracts ──────────────────────────────────────────────

  async deployContract(params: {
    scriptCbor: string;
    scriptType?: string;
    initialDatum?: string;
    lovelace?: number;
  }): Promise<DeployContractResult> {
    const lovelaceAmount = params.lovelace ?? 2_000_000;
    this.safety.enforceTransaction(lovelaceAmount);

    const lucid = await this.ensureLucid();
    const senderAddress = await lucid.wallet().address();
    const scriptType = params.scriptType ?? 'PlutusV2';

    const validator: SpendingValidator = {
      type: scriptType as any,
      script: applyDoubleCborEncoding(params.scriptCbor),
    };

    const scriptAddress = validatorToAddress('Mainnet', validator);
    const scriptHash = validatorToScriptHash(validator);
    const datum = params.initialDatum || Data.void();

    const tx = lucid.newTx()
      .pay.ToAddressWithData(scriptAddress, { kind: "inline", value: datum }, { lovelace: BigInt(lovelaceAmount) });

    const signBuilder = await tx.complete();
    const signedTx = await signBuilder.sign.withWallet().complete();
    const txHash = await signedTx.submit();

    this.safety.recordTransaction(txHash, lovelaceAmount, scriptAddress);

    return {
      txHash,
      sender: senderAddress,
      recipient: scriptAddress,
      amountLovelace: lovelaceAmount,
      scriptAddress,
      scriptHash,
      scriptType,
      explorerUrl: explorerTxLink(this.explorerUrl, txHash),
    };
  }

  async interactContract(params: {
    scriptCbor: string;
    scriptType?: string;
    action?: 'spend' | 'lock';
    redeemer?: string;
    datum?: string;
    lovelace?: number;
    utxoRef?: { txHash: string; outputIndex: number };
    assets?: Record<string, string>;
  }): Promise<InteractContractResult> {
    const lucid = await this.ensureLucid();
    const walletAddress = await lucid.wallet().address();
    const scriptType = params.scriptType ?? 'PlutusV2';
    const action = params.action ?? 'spend';
    const lovelaceAmount = params.lovelace ?? 2_000_000;

    const validator: SpendingValidator = {
      type: scriptType as any,
      script: applyDoubleCborEncoding(params.scriptCbor),
    };
    const scriptAddress = validatorToAddress('Mainnet', validator);

    if (action === 'lock') {
      this.safety.enforceTransaction(lovelaceAmount);

      const datumData = params.datum || Data.void();
      const outputAssets: Record<string, bigint> = { lovelace: BigInt(lovelaceAmount) };
      if (params.assets) {
        for (const [unit, qty] of Object.entries(params.assets)) {
          outputAssets[unit] = BigInt(qty);
        }
      }

      const tx = lucid.newTx()
        .pay.ToAddressWithData(scriptAddress, { kind: "inline", value: datumData }, outputAssets);

      const signBuilder = await tx.complete();
      const signedTx = await signBuilder.sign.withWallet().complete();
      const txHash = await signedTx.submit();

      this.safety.recordTransaction(txHash, lovelaceAmount, scriptAddress);

      return {
        txHash,
        sender: walletAddress,
        recipient: scriptAddress,
        amountLovelace: lovelaceAmount,
        scriptAddress,
        action: 'lock',
        explorerUrl: explorerTxLink(this.explorerUrl, txHash),
      };
    } else {
      // SPEND
      let scriptUtxos;
      if (params.utxoRef) {
        scriptUtxos = await lucid.utxosByOutRef([params.utxoRef]);
      } else {
        scriptUtxos = await lucid.utxosAt(scriptAddress);
      }

      if (!scriptUtxos || scriptUtxos.length === 0) {
        throw new TransactionError(`No UTxOs found at script address ${scriptAddress}`);
      }

      const redeemerData = params.redeemer || Data.void();

      let completedTx;
      try {
        completedTx = await lucid.newTx()
          .collectFrom(scriptUtxos, redeemerData)
          .attach.SpendingValidator(validator)
          .addSigner(walletAddress)
          .complete();
      } catch {
        completedTx = await lucid.newTx()
          .collectFrom(scriptUtxos, redeemerData)
          .attach.SpendingValidator(validator)
          .addSigner(walletAddress)
          .complete({ localUPLCEval: false });
      }

      const signedTx = await completedTx.sign.withWallet().complete();
      const txHash = await signedTx.submit();

      return {
        txHash,
        sender: walletAddress,
        recipient: scriptAddress,
        amountLovelace: 0,
        scriptAddress,
        action: 'spend',
        explorerUrl: explorerTxLink(this.explorerUrl, txHash),
      };
    }
  }

  // ─── Agent Registry ───────────────────────────────────────────────

  async registerAgent(params: {
    name: string;
    description: string;
    capabilities: string[];
    framework: string;
    endpoint: string;
  }): Promise<AgentRegistrationResult> {
    const lucid = await this.ensureLucid();
    return this.registry.register(lucid, params);
  }

  async discoverAgents(params?: {
    capability?: string;
    framework?: string;
    limit?: number;
  }): Promise<AgentProfile[]> {
    return this.registry.discover(params);
  }

  async getAgentProfile(agentId: string): Promise<AgentProfile> {
    return this.registry.getProfile(agentId);
  }

  async updateAgent(
    agentId: string,
    updates: {
      name?: string;
      description?: string;
      capabilities?: string[];
      framework?: string;
      endpoint?: string;
    },
  ): Promise<AgentUpdateResult> {
    const lucid = await this.ensureLucid();
    return this.registry.update(lucid, agentId, updates);
  }

  async deregisterAgent(agentId: string): Promise<AgentDeregistrationResult> {
    const lucid = await this.ensureLucid();
    return this.registry.deregister(lucid, agentId);
  }

  async transferAgent(agentId: string, newOwnerAddress: string): Promise<AgentTransferResult> {
    const lucid = await this.ensureLucid();
    return this.registry.transfer(lucid, agentId, newOwnerAddress);
  }

  async messageAgent(
    agentId: string,
    params: { type: 'inquiry' | 'proposal' | 'result'; payload: string },
  ): Promise<AgentMessageResult> {
    const lucid = await this.ensureLucid();
    return this.registry.messageAgent(lucid, agentId, params);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.lucid = null;
  }
}
