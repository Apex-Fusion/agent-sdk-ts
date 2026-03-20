import { readFileSync } from 'fs';
import { WalletError } from '../errors.js';
import type { WalletAdapter } from './types.js';
import type { LucidEvolution } from '@lucid-evolution/lucid';

export class SkeyWallet implements WalletAdapter {
  private readonly privateKeyHex: string;

  constructor(privateKeyHex: string) {
    this.privateKeyHex = privateKeyHex;
  }

  static fromFile(skeyPath: string): SkeyWallet {
    try {
      const data = JSON.parse(readFileSync(skeyPath, 'utf-8'));
      const cborHex: string = data.cborHex;
      if (!cborHex) throw new Error('Missing cborHex field');
      return SkeyWallet.fromCborHex(cborHex);
    } catch (err) {
      throw new WalletError(`Failed to load signing key from ${skeyPath}: ${err}`);
    }
  }

  static fromCborHex(cborHex: string): SkeyWallet {
    // Strip CBOR wrapper: 5820 prefix = 32-byte bytestring header
    const rawHex = cborHex.startsWith('5820') ? cborHex.slice(4) : cborHex;
    return new SkeyWallet(rawHex);
  }

  selectWallet(lucid: LucidEvolution): void {
    lucid.selectWallet.fromPrivateKey(this.privateKeyHex);
  }

  async getAddress(lucid: LucidEvolution): Promise<string> {
    return lucid.wallet().address();
  }
}
