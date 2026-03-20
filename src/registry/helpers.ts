// @ts-nocheck
// Pure helper functions for the agent registry.
// @ts-nocheck needed because Lucid's Data/Constr types are dynamically typed.

import { Data, Constr, fromText, toText, validatorToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { REGISTRY_SCRIPT_CBOR, REGISTRY_POLICY_ID } from '../constants.js';
import type { AgentProfile } from '../types.js';

/**
 * Derive NFT asset name = blake2b_256(CBOR(OutputReference)).
 * Matches Aiken's derive_asset_name.
 */
export function deriveNftAssetName(txHash: string, outputIndex: number): string {
  const outRefCbor = Data.to(new Constr(0, [txHash, BigInt(outputIndex)]));
  const hashBytes = blake2b(Buffer.from(outRefCbor, 'hex'), { dkLen: 32 });
  return Buffer.from(hashBytes).toString('hex');
}

/**
 * Build the on-chain agent datum CBOR.
 */
export function buildAgentDatum(
  vkeyHash: string,
  name: string,
  description: string,
  capabilities: string[],
  framework: string,
  endpoint: string,
  registeredAt?: number,
): string {
  return Data.to(new Constr(0, [
    new Constr(0, [vkeyHash]),
    fromText(name),
    fromText(description),
    capabilities.map(c => fromText(c)),
    fromText(framework),
    fromText(endpoint),
    BigInt(registeredAt ?? Date.now()),
  ]));
}

/**
 * Parse an on-chain agent datum CBOR back into an AgentProfile.
 */
export function parseAgentDatum(
  datumCbor: string,
  utxoRef: string,
  assets: Record<string, bigint>,
): AgentProfile | null {
  try {
    const c = Data.from(datumCbor);
    if (Number(c.index) !== 0) return null;
    const ownerCred = c.fields[0];
    const vkeyHash = ownerCred.fields[0];
    const nftUnit = Object.keys(assets).find(
      u => u.startsWith(REGISTRY_POLICY_ID) && assets[u] === 1n
    );
    const nftAssetName = nftUnit ? nftUnit.slice(REGISTRY_POLICY_ID.length) : '';
    return {
      agentId: `did:vector:agent:${REGISTRY_POLICY_ID}:${nftAssetName}`,
      name: toText(c.fields[1]),
      description: toText(c.fields[2]),
      capabilities: c.fields[3].map(toText),
      framework: toText(c.fields[4]),
      endpoint: toText(c.fields[5]),
      registeredAt: Number(c.fields[6]),
      utxoRef,
      ownerVkeyHash: vkeyHash,
    };
  } catch {
    return null;
  }
}

/**
 * Parse an agent DID string into its components.
 */
export function parseDid(agentId: string): { policyId: string; assetName: string; unit: string } {
  const parts = agentId.split(':');
  if (parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'vector' || parts[2] !== 'agent') {
    throw new Error('Invalid agent DID format. Expected: did:vector:agent:{policyId}:{nftAssetName}');
  }
  if (!/^[a-f0-9]+$/.test(parts[3]) || !/^[a-f0-9]+$/.test(parts[4])) {
    throw new Error('Invalid agent DID: policyId and assetName must be hex strings.');
  }
  return { policyId: parts[3], assetName: parts[4], unit: `${parts[3]}${parts[4]}` };
}

/**
 * Validate an endpoint URL (empty string is allowed).
 */
export function validateEndpoint(endpoint: string): void {
  if (!endpoint) return;
  try {
    new URL(endpoint);
  } catch {
    throw new Error(`Invalid endpoint URL: "${endpoint}". Must be a valid URL or empty string.`);
  }
}

/**
 * Validate capabilities array entries.
 */
export function validateCapabilities(capabilities: string[]): void {
  for (const cap of capabilities) {
    if (typeof cap !== 'string' || cap.trim().length === 0) {
      throw new Error('Each capability must be a non-empty string.');
    }
  }
}

// Cached registry address
let _registryAddress: string | null = null;

/**
 * Get the on-chain registry script address (cached).
 */
export function getRegistryAddress(): string {
  if (_registryAddress) return _registryAddress;
  const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
  _registryAddress = validatorToAddress('Mainnet', registryScript);
  return _registryAddress;
}

/**
 * Get the registry script hash.
 */
export function getRegistryScriptHash(): string {
  const registryScript = { type: 'PlutusV3' as const, script: REGISTRY_SCRIPT_CBOR };
  return validatorToScriptHash(registryScript);
}
