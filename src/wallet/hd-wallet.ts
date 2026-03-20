import { WalletError } from '../errors.js';
import type { WalletAdapter } from './types.js';
import type { LucidEvolution } from '@lucid-evolution/lucid';

export class HDWallet implements WalletAdapter {
  private readonly mnemonic: string;
  private readonly accountIndex: number;

  constructor(mnemonic: string, accountIndex: number = 0) {
    const trimmed = mnemonic.trim();
    const words = trimmed.split(/\s+/);
    const validLengths = [12, 15, 18, 21, 24];
    if (!validLengths.includes(words.length)) {
      throw new WalletError(
        `Invalid mnemonic: expected 12, 15, 18, 21, or 24 words, got ${words.length}`
      );
    }
    this.mnemonic = trimmed;
    this.accountIndex = accountIndex;
  }

  selectWallet(lucid: LucidEvolution): void {
    lucid.selectWallet.fromSeed(this.mnemonic, { accountIndex: this.accountIndex });
  }

  async getAddress(lucid: LucidEvolution): Promise<string> {
    return lucid.wallet().address();
  }
}
