import { describe, it, expect } from 'vitest';
import { lovelaceToAda, explorerTxLink, metadataStr, formatAssetName } from '../../src/utils.js';

describe('lovelaceToAda', () => {
  it('converts integer lovelace', () => {
    expect(lovelaceToAda(5_000_000)).toBe('5.000000');
  });

  it('converts bigint lovelace', () => {
    expect(lovelaceToAda(1_500_000n)).toBe('1.500000');
  });

  it('converts string lovelace', () => {
    expect(lovelaceToAda('2345678')).toBe('2.345678');
  });

  it('handles zero', () => {
    expect(lovelaceToAda(0)).toBe('0.000000');
  });
});

describe('explorerTxLink', () => {
  it('builds correct URL', () => {
    const url = explorerTxLink('https://explorer.example.com', 'abc123');
    expect(url).toBe('https://explorer.example.com/transaction/abc123');
  });
});

describe('metadataStr', () => {
  it('returns short strings as-is', () => {
    expect(metadataStr('hello')).toBe('hello');
  });

  it('returns string at exactly 64 chars as-is', () => {
    const s = 'a'.repeat(64);
    expect(metadataStr(s)).toBe(s);
  });

  it('chunks strings longer than 64 chars', () => {
    const s = 'a'.repeat(130);
    const result = metadataStr(s) as string[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(64);
    expect(result[1]).toHaveLength(64);
    expect(result[2]).toHaveLength(2);
    expect(result.join('')).toBe(s);
  });
});

describe('formatAssetName', () => {
  it('decodes valid hex to UTF-8', () => {
    // "tAPEX" = 7441504558
    expect(formatAssetName('7441504558')).toBe('tAPEX');
  });

  it('returns non-hex strings as-is', () => {
    expect(formatAssetName('hello')).toBe('hello');
  });

  it('returns empty string as-is', () => {
    expect(formatAssetName('')).toBe('');
  });
});
