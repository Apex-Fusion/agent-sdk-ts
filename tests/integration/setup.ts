import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname!, '../..');

export function getMnemonic(): string {
  const path = resolve(PROJECT_ROOT, 'mnemonic.txt');
  const mnemonic = readFileSync(path, 'utf-8').trim();
  const wordCount = mnemonic.split(/\s+/).length;
  const validLengths = [12, 15, 18, 21, 24];
  if (!validLengths.includes(wordCount)) {
    throw new Error(`mnemonic.txt has ${wordCount} words, expected one of: ${validLengths.join(', ')}`);
  }
  return mnemonic;
}

export function wait(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

const KNOWN_ERROR_PATTERNS = [
  'insufficient',
  'No UTxOs',
  'Credential-based UTxO',
  'No variant matched',
  'InputsExhaustedError',
  'not enough',
  'No UTxOs in wallet',
  'does not have enough funds',
  'SpendLimitExceededError',
  'exceeds per-transaction limit',
  'daily spend limit',
];

export function isKnownFundingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return KNOWN_ERROR_PATTERNS.some(p => msg.includes(p));
}

export async function tryOrSkipIfUnfunded<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    const result = await fn();
    console.log(`  [pass] ${label} succeeded`);
    return result;
  } catch (err) {
    if (isKnownFundingError(err)) {
      console.log(`  [skip] ${label} -- wallet likely unfunded: ${(err as Error).message.substring(0, 120)}`);
      return null;
    }
    throw err;
  }
}
