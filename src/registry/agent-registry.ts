// @ts-nocheck
// Agent registry class — extracted from web3-mcp agent-network.ts.
// @ts-nocheck needed because Lucid's Data/Constr types are dynamically typed.

import { Data, Constr, fromText, getAddressDetails, validatorToAddress, credentialToAddress } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '../chain/ogmios-provider.js';
import { SafetyLayer } from '../safety/safety-layer.js';
import { RegistryError } from '../errors.js';
import { REGISTRY_SCRIPT_CBOR, REGISTRY_POLICY_ID, MIN_AP3X_DEPOSIT, AGENT_MESSAGE_LABEL } from '../constants.js';
import { lovelaceToAda, explorerTxLink, metadataStr } from '../utils.js';
import {
  deriveNftAssetName, buildAgentDatum, parseAgentDatum, parseDid,
  validateEndpoint, validateCapabilities, getRegistryAddress,
} from './helpers.js';
import type {
  AgentProfile, AgentRegistrationResult, AgentUpdateResult,
  AgentDeregistrationResult, AgentTransferResult, AgentMessageResult,
} from '../types.js';

export class AgentRegistry {
  constructor(
    private readonly provider: OgmiosProvider,
    private readonly safety: SafetyLayer,
    private readonly explorerUrl: string,
  ) {}

  async register(
    lucid: LucidEvolution,
    params: {
      name: string;
      description: string;
      capabilities: string[];
      framework: string;
      endpoint: string;
    },
  ): Promise<AgentRegistrationResult> {
    validateEndpoint(params.endpoint);
    validateCapabilities(params.capabilities);

    this.safety.enforceTransaction(Number(MIN_AP3X_DEPOSIT));

    const walletAddress = await lucid.wallet().address();
    const addressDetails = getAddressDetails(walletAddress);
    const vkeyHash = addressDetails.paymentCredential?.hash;
    if (!vkeyHash) throw new RegistryError('Cannot derive payment key hash from wallet address');

    const utxos = await lucid.utxosAt(walletAddress);
    const seedUtxo = utxos.find(u => {
      const keys = Object.keys(u.assets);
      return keys.length === 1 && keys[0] === 'lovelace' && u.assets['lovelace'] >= MIN_AP3X_DEPOSIT + 2_000_000n;
    }) || utxos[0];
    if (!seedUtxo) throw new RegistryError('No UTxOs in wallet. Please fund the wallet first.');

    const nftAssetName = deriveNftAssetName(seedUtxo.txHash, seedUtxo.outputIndex);
    const nftUnit = `${REGISTRY_POLICY_ID}${nftAssetName}`;
    const datum = buildAgentDatum(vkeyHash, params.name, params.description, params.capabilities, params.framework, params.endpoint);
    const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
    const registryAddress = validatorToAddress('Mainnet', registryScript);
    const registerRedeemer = Data.to(new Constr(0, [new Constr(0, [seedUtxo.txHash, BigInt(seedUtxo.outputIndex)])]));

    const tx = await lucid.newTx()
      .collectFrom([seedUtxo])
      .mintAssets({ [nftUnit]: 1n }, registerRedeemer)
      .attach.MintingPolicy(registryScript)
      .pay.ToAddressWithData(registryAddress, { kind: "inline", value: datum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
      .addSigner(walletAddress)
      .complete();
    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    this.safety.recordTransaction(txHash, Number(MIN_AP3X_DEPOSIT), registryAddress);

    const agentId = `did:vector:agent:${REGISTRY_POLICY_ID}:${nftAssetName}`;
    return {
      agentId,
      nftAssetName,
      txHash,
      explorerUrl: explorerTxLink(this.explorerUrl, txHash),
    };
  }

  async discover(params?: {
    capability?: string;
    framework?: string;
    limit?: number;
  }): Promise<AgentProfile[]> {
    const registryAddress = getRegistryAddress();
    const utxos = await this.provider.getUtxos(registryAddress);
    const profiles: AgentProfile[] = [];
    const maxResults = params?.limit ?? 20;

    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      const profile = parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets);
      if (!profile) continue;
      if (params?.capability && !profile.capabilities.some(c => c.toLowerCase().includes(params.capability!.toLowerCase()))) continue;
      if (params?.framework && profile.framework.toLowerCase() !== params.framework.toLowerCase()) continue;
      profiles.push(profile);
      if (profiles.length >= maxResults) break;
    }

    return profiles;
  }

  async getProfile(agentId: string): Promise<AgentProfile> {
    const { profile } = await this.resolveAgentUtxo(agentId);
    return profile;
  }

  async update(
    lucid: LucidEvolution,
    agentId: string,
    updates: {
      name?: string;
      description?: string;
      capabilities?: string[];
      framework?: string;
      endpoint?: string;
    },
  ): Promise<AgentUpdateResult> {
    if (!updates.name && !updates.description && !updates.capabilities && !updates.framework && updates.endpoint === undefined) {
      throw new RegistryError('At least one field must be provided to update.');
    }
    if (updates.endpoint !== undefined) validateEndpoint(updates.endpoint);
    if (updates.capabilities) validateCapabilities(updates.capabilities);

    const walletAddress = await lucid.wallet().address();
    const vkeyHash = getAddressDetails(walletAddress).paymentCredential?.hash;
    if (!vkeyHash) throw new RegistryError('Cannot derive payment key hash from wallet address');

    const { profile, utxo, nftUnit } = await this.resolveAgentUtxo(agentId);
    this.verifyOwnership(profile, vkeyHash);

    const newDatum = buildAgentDatum(
      vkeyHash,
      updates.name ?? profile.name,
      updates.description ?? profile.description,
      updates.capabilities ?? profile.capabilities,
      updates.framework ?? profile.framework,
      updates.endpoint ?? profile.endpoint,
      profile.registeredAt,
    );
    const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
    const registryAddress = validatorToAddress('Mainnet', registryScript);
    const spendRedeemer = Data.to(new Constr(0, [])); // Update

    const tx = await lucid.newTx()
      .collectFrom([utxo], spendRedeemer)
      .attach.SpendingValidator(registryScript)
      .pay.ToAddressWithData(registryAddress, { kind: "inline", value: newDatum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
      .addSigner(walletAddress)
      .complete();
    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    this.safety.recordTransaction(txHash, 0, registryAddress);

    const updatedFields: string[] = [];
    if (updates.name !== undefined) updatedFields.push('name');
    if (updates.description !== undefined) updatedFields.push('description');
    if (updates.capabilities !== undefined) updatedFields.push('capabilities');
    if (updates.framework !== undefined) updatedFields.push('framework');
    if (updates.endpoint !== undefined) updatedFields.push('endpoint');

    return {
      agentId,
      txHash,
      updatedFields,
      explorerUrl: explorerTxLink(this.explorerUrl, txHash),
    };
  }

  async deregister(lucid: LucidEvolution, agentId: string): Promise<AgentDeregistrationResult> {
    const walletAddress = await lucid.wallet().address();
    const vkeyHash = getAddressDetails(walletAddress).paymentCredential?.hash;
    if (!vkeyHash) throw new RegistryError('Cannot derive payment key hash from wallet address');

    const { profile, utxo, nftUnit } = await this.resolveAgentUtxo(agentId);
    this.verifyOwnership(profile, vkeyHash);

    const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
    const spendRedeemer = Data.to(new Constr(1, [])); // Deregister
    const mintRedeemer = Data.to(new Constr(1, []));  // Burn

    const tx = await lucid.newTx()
      .collectFrom([utxo], spendRedeemer)
      .attach.SpendingValidator(registryScript)
      .mintAssets({ [nftUnit]: -1n }, mintRedeemer)
      .attach.MintingPolicy(registryScript)
      .addSigner(walletAddress)
      .complete();
    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    this.safety.recordTransaction(txHash, 0, walletAddress);

    return {
      agentId,
      txHash,
      depositReturned: lovelaceToAda(MIN_AP3X_DEPOSIT),
      explorerUrl: explorerTxLink(this.explorerUrl, txHash),
    };
  }

  async transfer(
    lucid: LucidEvolution,
    agentId: string,
    newOwnerAddress: string,
  ): Promise<AgentTransferResult> {
    const walletAddress = await lucid.wallet().address();
    const vkeyHash = getAddressDetails(walletAddress).paymentCredential?.hash;
    if (!vkeyHash) throw new RegistryError('Cannot derive payment key hash from wallet address');

    let newOwnerDetails;
    try {
      newOwnerDetails = getAddressDetails(newOwnerAddress);
    } catch {
      throw new RegistryError(`Invalid new owner address: "${newOwnerAddress}".`);
    }
    if (newOwnerDetails.paymentCredential?.type !== 'Key') {
      throw new RegistryError('New owner address must be a verification key credential, not a script address.');
    }
    const newOwnerVkeyHash = newOwnerDetails.paymentCredential.hash;

    const { profile, utxo, nftUnit } = await this.resolveAgentUtxo(agentId);
    this.verifyOwnership(profile, vkeyHash);

    const newDatum = buildAgentDatum(
      newOwnerVkeyHash, profile.name, profile.description,
      profile.capabilities, profile.framework, profile.endpoint,
      profile.registeredAt,
    );
    const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
    const registryAddress = validatorToAddress('Mainnet', registryScript);
    const spendRedeemer = Data.to(new Constr(0, [])); // Update (transfer uses Update redeemer)

    const tx = await lucid.newTx()
      .collectFrom([utxo], spendRedeemer)
      .attach.SpendingValidator(registryScript)
      .pay.ToAddressWithData(registryAddress, { kind: "inline", value: newDatum }, { lovelace: MIN_AP3X_DEPOSIT, [nftUnit]: 1n })
      .addSigner(walletAddress)
      .complete();
    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    this.safety.recordTransaction(txHash, 0, registryAddress);

    return {
      agentId,
      txHash,
      newOwnerAddress,
      explorerUrl: explorerTxLink(this.explorerUrl, txHash),
    };
  }

  async messageAgent(
    lucid: LucidEvolution,
    agentId: string,
    params: { type: 'inquiry' | 'proposal' | 'result'; payload: string },
  ): Promise<AgentMessageResult> {
    const { profile } = await this.resolveAgentUtxo(agentId);
    if (!profile.ownerVkeyHash) throw new RegistryError('Could not parse agent owner from registry datum');

    const senderAddress = await lucid.wallet().address();
    const recipientAddress = credentialToAddress('Mainnet', { type: 'Key', hash: profile.ownerVkeyHash });
    const minAda = 2_000_000n;
    this.safety.enforceTransaction(Number(minAda));

    const tx = await lucid.newTx()
      .pay.ToAddress(recipientAddress, { lovelace: minAda })
      .attachMetadata(AGENT_MESSAGE_LABEL, {
        msg: ['a2a'],
        from: metadataStr(senderAddress),
        to: metadataStr(agentId),
        type: params.type,
        payload: metadataStr(params.payload),
      })
      .complete();
    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    this.safety.recordTransaction(txHash, Number(minAda), recipientAddress);

    return {
      txHash,
      recipientAddress,
      messageType: params.type,
      explorerUrl: explorerTxLink(this.explorerUrl, txHash),
    };
  }

  // ─── Private ────────────────────────────────────────────────────────

  private async resolveAgentUtxo(agentId: string): Promise<{ profile: AgentProfile; utxo: UTxO; nftUnit: string }> {
    const { unit } = parseDid(agentId);

    let utxo: UTxO | undefined;
    try {
      utxo = await this.provider.getUtxoByUnit(unit);
    } catch {
      // Koios unavailable or asset not found — try Ogmios fallback
    }

    if (!utxo || !utxo.datum) {
      const registryAddress = getRegistryAddress();
      const allUtxos = await this.provider.getUtxos(registryAddress);
      const ogmiosUtxo = allUtxos.find(u => u.assets[unit] && u.assets[unit] > 0n);
      if (ogmiosUtxo) utxo = ogmiosUtxo;
    }

    if (!utxo) throw new RegistryError(`Agent not found: no UTxO holds NFT ${unit}. The agent may not exist or may have deregistered.`);
    if (!utxo.datum) throw new RegistryError('Registry UTxO found but has no inline datum.');

    const profile = parseAgentDatum(utxo.datum, `${utxo.txHash}#${utxo.outputIndex}`, utxo.assets);
    if (!profile) throw new RegistryError('Could not parse agent datum. The on-chain data may be malformed.');

    return { profile, utxo, nftUnit: unit };
  }

  private verifyOwnership(profile: AgentProfile, walletVkeyHash: string): void {
    if (profile.ownerVkeyHash !== walletVkeyHash) {
      throw new RegistryError('Ownership check failed: your wallet does not own this agent.');
    }
  }
}
