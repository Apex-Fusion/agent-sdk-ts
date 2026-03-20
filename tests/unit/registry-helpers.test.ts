import { describe, it, expect } from 'vitest';
import { parseDid } from '../../src/registry/helpers.js';

describe('parseDid', () => {
  it('parses a valid agent DID', () => {
    const did = 'did:vector:agent:5dd5118943d5aa7329696181252a6565a27dbf2c6de92b02a6aae361:abc123def456';
    const result = parseDid(did);
    expect(result.policyId).toBe('5dd5118943d5aa7329696181252a6565a27dbf2c6de92b02a6aae361');
    expect(result.assetName).toBe('abc123def456');
    expect(result.unit).toBe('5dd5118943d5aa7329696181252a6565a27dbf2c6de92b02a6aae361abc123def456');
  });

  it('rejects invalid DID format', () => {
    expect(() => parseDid('invalid')).toThrow('Invalid agent DID format');
    expect(() => parseDid('did:vector:abc:def:ghi')).toThrow('Invalid agent DID format');
    expect(() => parseDid('did:other:agent:abc:def')).toThrow('Invalid agent DID format');
  });

  it('rejects non-hex policyId or assetName', () => {
    expect(() => parseDid('did:vector:agent:ZZZZ:abcd')).toThrow('must be hex strings');
    expect(() => parseDid('did:vector:agent:abcd:ZZZZ')).toThrow('must be hex strings');
  });
});
