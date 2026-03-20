import { describe, it, expect } from 'vitest';
import { HDWallet } from '../../src/wallet/hd-wallet.js';
import { WalletError } from '../../src/errors.js';

const VALID_15 = 'test test test test test test test test test test test test test test test';
const VALID_24 = 'test test test test test test test test test test test test test test test test test test test test test test test test';

describe('HDWallet', () => {
  it('accepts 15-word mnemonic', () => {
    expect(() => new HDWallet(VALID_15)).not.toThrow();
  });

  it('accepts 24-word mnemonic', () => {
    expect(() => new HDWallet(VALID_24)).not.toThrow();
  });

  it('accepts 12-word mnemonic', () => {
    const m12 = 'test test test test test test test test test test test test';
    expect(() => new HDWallet(m12)).not.toThrow();
  });

  it('rejects invalid word count', () => {
    const m5 = 'test test test test test';
    expect(() => new HDWallet(m5)).toThrow(WalletError);
    expect(() => new HDWallet(m5)).toThrow(/expected 12, 15, 18, 21, or 24 words/i);
  });

  it('trims whitespace', () => {
    const padded = '  ' + VALID_15 + '  ';
    expect(() => new HDWallet(padded)).not.toThrow();
  });

  it('handles multiple spaces between words', () => {
    const spaced = 'test  test  test  test  test  test  test  test  test  test  test  test  test  test  test';
    expect(() => new HDWallet(spaced)).not.toThrow();
  });

  it('defaults to account index 0', () => {
    // Just ensure construction succeeds — we can't test Lucid selection without a live instance
    const wallet = new HDWallet(VALID_15);
    expect(wallet).toBeDefined();
  });
});
