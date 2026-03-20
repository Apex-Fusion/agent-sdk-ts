import type { LucidEvolution } from '@lucid-evolution/lucid';

export interface WalletAdapter {
  selectWallet(lucid: LucidEvolution): void;
  getAddress(lucid: LucidEvolution): Promise<string>;
}
