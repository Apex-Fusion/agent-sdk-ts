/**
 * IdentityChain: the chain reads and the evaluation that the identity
 * clients need. `OgmiosProvider` implements it on Ogmios (JSON-RPC v6) and
 * Koios (v1); tests and other back ends can give their own implementation.
 *
 * Outputs use the UTxO shape of the vendored builders (`ChainUtxo`): the
 * inline datum as CBOR hex, and a reference script as its single CBOR byte
 * string around the flat program (the form that the ledger hashes,
 * `blake2b_224(0x03 ‖ script)`).
 */
import type { ProtocolParameters as LucidProtocolParameters } from '@lucid-evolution/lucid';
import { z } from 'zod';
import type { ExUnits, NetworkId, OutputReference, SlotConfig, Utxo } from '../identity/vendor.js';

export type { OutputReference, SlotConfig };

/** An unspent output in the shape of the vendored builders. */
export type ChainUtxo = Utxo;

/** Execution units per redeemer, keyed `"<tag>:<index>"` (for example `"spend:0"`), as `TxContext.exUnits` takes them. */
export type RedeemerUnits = Record<string, ExUnits>;

/** The chain reads of the identity clients. */
export interface IdentityChain {
  /** Current protocol parameters, including the Plutus V3 cost model in ledger order. */
  getProtocolParameters(): Promise<LucidProtocolParameters>;
  /** The slot of the ledger tip. */
  getTipSlot(): Promise<number>;
  /** The slot clock of the current era. */
  getSlotConfig(): Promise<SlotConfig>;
  /** The unspent outputs at an address. */
  queryUtxosAt(address: string): Promise<ChainUtxo[]>;
  /** The unspent outputs among `refs`; spent or unknown references are left out. */
  queryUtxosByRefs(refs: readonly OutputReference[]): Promise<ChainUtxo[]>;
  /** The unspent outputs that hold the token `policyId.assetName`. */
  queryTokenUtxos(policyId: string, assetName: string): Promise<ChainUtxo[]>;
  /**
   * The reward balance of the stake credential `Script(scriptHash)`, or null when it is not registered.
   * `networkId` gives the reward address (CIP-19 header `0xf0 | networkId`).
   */
  getRewardBalance(scriptHash: string, networkId: NetworkId): Promise<bigint | null>;
  /** The execution units of each redeemer of a transaction. Throws when a script fails. */
  evaluateRedeemers(txCborHex: string): Promise<RedeemerUnits>;
  /** Submits a signed transaction and returns its ID. */
  submitTx(txCborHex: string): Promise<string>;
}

const hex = z.string().regex(/^[0-9a-fA-F]*$/, 'expected hexadecimal text').transform((s) => s.toLowerCase());
const quantity = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/), z.bigint()]);

/**
 * One UTxO of Ogmios v6 `queryLedgerState/utxo` (https://ogmios.dev/api/v6/):
 * `{ transaction: { id }, index, address, value: { ada: { lovelace }, <policy>: { <name>: qty } },
 * datumHash?, datum?, script?: { language, cbor } }`.
 */
const ogmiosUtxo = z.object({
  transaction: z.object({ id: hex }),
  index: z.number().int().nonnegative(),
  address: z.string().min(1),
  value: z.record(z.string(), z.record(z.string(), quantity)),
  datumHash: hex.optional(),
  datum: hex.optional(),
  script: z.object({ language: z.string(), cbor: hex.optional() }).passthrough().optional(),
});

/** An Ogmios v6 UTxO object as a `ChainUtxo`. Throws when the shape is not the Ogmios v6 shape. */
export function ogmiosUtxoToChainUtxo(raw: unknown): ChainUtxo {
  const parsed = ogmiosUtxo.safeParse(raw);
  if (!parsed.success) throw new Error(`unexpected Ogmios UTxO: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const u = parsed.data;
  const assets: Record<string, bigint> = {};
  let lovelace = 0n;
  for (const [policy, bundle] of Object.entries(u.value)) {
    for (const [name, amount] of Object.entries(bundle)) {
      if (policy === 'ada') {
        if (name === 'lovelace') lovelace = BigInt(amount);
        continue;
      }
      assets[`${policy.toLowerCase()}${name.toLowerCase()}`] = BigInt(amount);
    }
  }
  return {
    ref: { txHash: u.transaction.id, index: u.index },
    address: u.address,
    lovelace,
    assets,
    datumHex: u.datum ?? null,
    scriptRef: u.script?.cbor ?? null,
  };
}
