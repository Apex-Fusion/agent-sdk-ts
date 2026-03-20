import { describe, it, expect } from 'vitest';
import { SkeyWallet } from '../../src/wallet/skey-wallet.js';
import { WalletError } from '../../src/errors.js';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkeyWallet', () => {
  it('fromCborHex strips 5820 prefix', () => {
    const rawKey = 'a'.repeat(64);
    const cborHex = '5820' + rawKey;
    const wallet = SkeyWallet.fromCborHex(cborHex);
    expect(wallet).toBeDefined();
  });

  it('fromCborHex handles hex without prefix', () => {
    const rawKey = 'b'.repeat(64);
    const wallet = SkeyWallet.fromCborHex(rawKey);
    expect(wallet).toBeDefined();
  });

  it('fromFile parses cardano-cli JSON envelope', () => {
    const tmpFile = join(tmpdir(), `test-skey-${Date.now()}.json`);
    const skeyJson = {
      type: 'PaymentSigningKeyShelley_ed25519',
      description: 'Payment Signing Key',
      cborHex: '5820' + 'c'.repeat(64),
    };
    writeFileSync(tmpFile, JSON.stringify(skeyJson));
    try {
      const wallet = SkeyWallet.fromFile(tmpFile);
      expect(wallet).toBeDefined();
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('fromFile throws WalletError on missing file', () => {
    expect(() => SkeyWallet.fromFile('/nonexistent/path.skey')).toThrow(WalletError);
  });

  it('fromFile throws WalletError on invalid JSON', () => {
    const tmpFile = join(tmpdir(), `test-skey-bad-${Date.now()}.json`);
    writeFileSync(tmpFile, 'not json');
    try {
      expect(() => SkeyWallet.fromFile(tmpFile)).toThrow(WalletError);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('fromFile throws WalletError on missing cborHex field', () => {
    const tmpFile = join(tmpdir(), `test-skey-nocbor-${Date.now()}.json`);
    writeFileSync(tmpFile, JSON.stringify({ type: 'test' }));
    try {
      expect(() => SkeyWallet.fromFile(tmpFile)).toThrow(WalletError);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});
