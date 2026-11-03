import { IdentityLookupError } from './errors.js';
import { isVectorId, parseVectorDid } from './vendor.js';

/**
 * The 64-hex identifier of an input that is an identifier, a canonical
 * `did:vector:<id>` or a legacy `did:vector:agent:<policy>:<id>` DID.
 */
export function toVectorId(agent: string, label = 'agent'): string {
  if (isVectorId(agent)) return agent;
  const parsed = parseVectorDid(agent);
  if (parsed === null || parsed.form === 'network') {
    throw new IdentityLookupError(`${label}: ${agent} is not a vector-id or a did:vector DID of Vector mainnet`);
  }
  return parsed.vectorId;
}
