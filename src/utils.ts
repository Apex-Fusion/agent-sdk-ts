/**
 * Convert lovelace to human-readable ADA string with 6 decimal places.
 */
export function lovelaceToAda(lovelace: string | number | bigint): string {
  return (Number(BigInt(String(lovelace))) / 1_000_000).toFixed(6);
}

/**
 * Remove every trailing `/` from a URL. A loop, not the regex `/\/+$/`: that
 * regex takes quadratic time on input with many `/` characters.
 */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end -= 1;
  return url.slice(0, end);
}

/**
 * Build an explorer transaction link.
 */
export function explorerTxLink(explorerUrl: string, txHash: string): string {
  return `${trimTrailingSlashes(explorerUrl)}/transaction/${txHash}`;
}

/**
 * Chunk a string into <=64 byte segments for Cardano metadata.
 * Cardano metadata strings must be <= 64 bytes.
 */
export function metadataStr(s: string): string | string[] {
  if (s.length <= 64) return s;
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += 64) {
    chunks.push(s.slice(i, i + 64));
  }
  return chunks;
}

/**
 * Decode a hex-encoded asset name to UTF-8. Returns raw hex if decoding fails.
 */
export function formatAssetName(name: string): string {
  try {
    if (/^[0-9a-fA-F]+$/.test(name) && name.length > 0) {
      return Buffer.from(name, 'hex').toString('utf8');
    }
    return name;
  } catch {
    return name;
  }
}
