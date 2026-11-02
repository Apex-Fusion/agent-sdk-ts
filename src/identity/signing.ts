/**
 * Signing of the unsigned transactions that the identity clients return.
 * The body bytes stay as built, so the transaction ID does not change while
 * each key holder adds a witness in turn (Part 2 §10). The SDK never stores a
 * key: each function takes the key for one call only.
 */
import {
  addVKeyWitnesses,
  blake2b224Hex,
  bytesToHex,
  hexToBytes,
  readCbor,
  signTransaction as signWithRawKey,
  transactionId,
  type UnsignedTx,
} from './vendor.js';

export { addVKeyWitnesses, transactionId };

/**
 * The 32-byte Ed25519 private key of a hex key: raw (64 hex characters) or
 * the `cborHex` of a cardano-cli `PaymentSigningKeyShelley_ed25519` file
 * (`5820` + 64 hex characters).
 */
function rawPrivateKey(key: string | Uint8Array): string {
  const hex = typeof key === 'string' ? key.trim().toLowerCase() : bytesToHex(key);
  const raw = hex.length === 68 && hex.startsWith('5820') ? hex.slice(4) : hex;
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error('an Ed25519 private key has 32 bytes (or the cborHex 5820… of a cardano-cli key)');
  return raw;
}

/** Adds the witness of each Ed25519 private key; returns the transaction CBOR hex. */
export async function signTransaction(tx: UnsignedTx | string, ...privateKeys: Array<string | Uint8Array>): Promise<string> {
  let cbor = typeof tx === 'string' ? tx : tx.txCborHex;
  for (const key of privateKeys) cbor = await signWithRawKey(cbor, rawPrivateKey(key));
  return cbor;
}

/** The key hashes of the transaction's key witnesses. */
export function witnessKeyHashes(tx: UnsignedTx | string): string[] {
  const parsed = readCbor(hexToBytes(typeof tx === 'string' ? tx : tx.txCborHex));
  if (parsed.kind !== 'array' || parsed.items[1]?.kind !== 'map') throw new Error('not a Conway transaction');
  const hashes: string[] = [];
  for (const [key, value] of parsed.items[1].entries) {
    if (key.kind !== 'uint' || key.value !== 0n) continue;
    const list = value.kind === 'tag' ? value.item : value;
    if (list.kind !== 'array') continue;
    for (const witness of list.items) {
      if (witness.kind === 'array' && witness.items[0]?.kind === 'bytes') hashes.push(blake2b224Hex(witness.items[0].value));
    }
  }
  return hashes;
}

/** The required signers of `tx` that `signed` has no key witness for yet. */
export function missingSigners(tx: UnsignedTx, signed: string = tx.txCborHex): string[] {
  const present = new Set(witnessKeyHashes(signed));
  return tx.requiredSigners.filter((hash) => !present.has(hash));
}
