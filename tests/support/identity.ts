/**
 * Test support for the identity clients: an in-memory chain (`FakeChain`)
 * that applies built transactions to its UTxO set, throwaway test keys, and
 * the offline evaluation of a transaction with `aiken tx simulate` through
 * the vendored legacy-registry harness (tests/vendor/…/harness, unchanged).
 *
 * `builtFromCbor` follows `builtFromUnsigned` of agents-marketplace
 * tests/legacy-registry/harness/identity.ts, but reads everything from the
 * transaction CBOR, so the in-memory chain can evaluate a transaction from
 * its bytes alone, as Ogmios does. Nothing here goes to a network.
 */
import { spawnSync } from 'node:child_process';
import { sign as nodeSign } from 'node:crypto';
import type { ProtocolParameters as LucidProtocolParameters } from '@lucid-evolution/lucid';
import * as cbor from '../vendor/agents-marketplace/tests/legacy-registry/harness/cbor.js';
import { encodeData, type Data } from '../vendor/agents-marketplace/tests/legacy-registry/harness/data.js';
import type { CborItem as Item } from '../../src/vendor/agents-marketplace/packages/shared/src/identity/tx/cbor.js';
import {
  address,
  bech32Address,
  blake2b256,
  chainUtxo,
  fromHex,
  minUtxo,
  testKeyPair,
  toHex,
  type BuiltTx,
  type KeyPair,
  type TxOut,
  type Utxo as HarnessUtxo,
} from '../vendor/agents-marketplace/tests/legacy-registry/harness/ledger.js';
import { simulate, type Simulation } from '../vendor/agents-marketplace/tests/legacy-registry/harness/simulate.js';
import {
  addressBytes,
  decodePlutusDataHex,
  paymentCredential,
  readCbor,
  transactionId,
  VECTOR_MAINNET_SLOT_CONFIG,
  type PlutusData,
} from '../../src/identity/vendor.js';
import type { ChainUtxo, IdentityChain, OutputReference, RedeemerUnits, SlotConfig } from '../../src/chain/identity-chain.js';
import { TransactionError } from '../../src/errors.js';
import type { UnsignedTx } from '../../src/identity/index.js';

export const AP3X = 1_000_000n;

/** 2025-11-01T12:26:40Z, a slot start on the Vector clock. */
export const TEST_NOW = 1_762_000_000_000;
export const TEST_TIP_SLOT = (TEST_NOW - VECTOR_MAINNET_SLOT_CONFIG.zeroTimeMs) / VECTOR_MAINNET_SLOT_CONFIG.slotLengthMs;

/**
 * Protocol parameters as the chain layer gives them (lucid's shape). The
 * values are Vector mainnet's; Ogmios v6 gives the cost model as a list,
 * which lucid's type calls a record, so the object is cast once here.
 */
export const TEST_PROTOCOL = {
  minFeeA: 44,
  minFeeB: 155_381,
  maxTxSize: 16_384,
  maxValSize: 5_000,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  govActionDeposit: 100_000_000_000n,
  priceMem: 0.0577,
  priceStep: 0.0000721,
  maxTxExMem: 16_000_000n,
  maxTxExSteps: 10_000_000_000n,
  coinsPerUtxoByte: 4310n,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  minFeeRefScriptCostPerByte: 15,
  costModels: { PlutusV1: {}, PlutusV2: {}, PlutusV3: Array.from({ length: 297 }, (_, i) => 1000 + i) },
} as unknown as LucidProtocolParameters;

/** A Plutus V3 script that accepts every purpose: `(program 1.1.0 (lam ctx (con unit ())))`. The test Module-1. */
export const MODULE1_STAND_IN = '450101002499';

export const refKey = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

// ─── Conversions between the SDK and the harness ────────────────────

export function harnessData(d: PlutusData): Data {
  switch (d.kind) {
    case 'int':
      return d.value;
    case 'bytes':
      return fromHex(d.hex);
    case 'list':
      return d.items.map(harnessData);
    case 'map':
      return { map: d.entries.map(([k, v]) => [harnessData(k), harnessData(v)] as const) };
    case 'constr':
      return { constr: Number(d.index), fields: d.fields.map(harnessData) };
  }
}

export function toChainUtxo(u: HarnessUtxo): ChainUtxo {
  const assets: Record<string, bigint> = {};
  for (const a of u.output.value.assets ?? []) assets[`${toHex(a.policy)}${toHex(a.name)}`] = a.quantity;
  const datum = u.output.datum;
  return {
    ref: { txHash: toHex(u.ref.txId), index: u.ref.index },
    address: bech32Address(u.output.address),
    lovelace: u.output.value.coin,
    assets,
    // The harness encoder writes the same bytes as Aiken `cbor.serialise`.
    datumHex: datum !== undefined && 'inline' in datum ? toHex(encodeData(datum.inline)) : null,
    scriptRef: u.output.referenceScript === undefined ? null : toHex(u.output.referenceScript.compiledCode),
  };
}

export function toHarnessUtxo(u: ChainUtxo): HarnessUtxo {
  const output: TxOut = {
    address: addressBytes(u.address),
    value: {
      coin: u.lovelace,
      assets: Object.entries(u.assets).map(([unit, quantity]) => ({ policy: fromHex(unit.slice(0, 56)), name: fromHex(unit.slice(56)), quantity })),
    },
    ...(u.datumHex === null ? {} : { datum: { inline: harnessData(decodePlutusDataHex(u.datumHex)) } }),
    ...(u.scriptRef === null ? {} : { referenceScript: { compiledCode: fromHex(u.scriptRef) } }),
  };
  return { ref: { txId: fromHex(u.ref.txHash), index: u.ref.index }, output };
}

// ─── Test keys and funds ────────────────────────────────────────────

export interface TestWallet {
  key: KeyPair;
  /** The raw 32-byte Ed25519 private key (hex), for the SDK's `signTransaction`. */
  privateKey: string;
  publicKey: string;
  keyHash: string;
  address: string;
}

/** A throwaway key (the harness derivation) and its enterprise address. */
export function testWallet(label: string): TestWallet {
  const key = testKeyPair(label);
  return {
    key,
    privateKey: toHex(blake2b256(new TextEncoder().encode(`legacy-registry test key: ${label}`))),
    publicKey: toHex(key.publicKey),
    keyHash: toHex(key.keyHash),
    address: bech32Address(address({ key: key.keyHash })),
  };
}

/** AP3X at a wallet, created by an earlier transaction named `label`. */
export function fund(label: string, wallet: TestWallet, coin: bigint, index = 0): ChainUtxo {
  return toChainUtxo(chainUtxo(label, { address: addressBytes(wallet.address), value: { coin } }, index));
}

/** A reference-script output at the enterprise address with 28 zero bytes (Part 2 §2). */
export function referenceScriptUtxo(label: string, compiledCode: string): ChainUtxo {
  const shape: TxOut = { address: address({ key: new Uint8Array(28) }), value: { coin: 0n }, referenceScript: { compiledCode: fromHex(compiledCode) } };
  return toChainUtxo(chainUtxo(label, { ...shape, value: { coin: minUtxo({ ...shape, value: { coin: 100_000_000n } }) } }));
}

// ─── Reading a transaction ──────────────────────────────────────────

const TAGS: Record<number, 'spend' | 'mint' | 'withdraw'> = { 0: 'spend', 1: 'mint', 3: 'withdraw' };

function entry(map: Item, key: number): Item | undefined {
  if (map.kind !== 'map') throw new Error('not a CBOR map');
  return map.entries.find(([k]) => k.kind === 'uint' && k.value === BigInt(key))?.[1];
}

function refsAt(body: Item, key: number): OutputReference[] {
  let list = entry(body, key);
  if (list === undefined) return [];
  if (list.kind === 'tag') list = list.item;
  if (list.kind !== 'array') throw new Error(`body field ${key} is not a list`);
  return list.items.map((item) => {
    if (item.kind !== 'array' || item.items[0]?.kind !== 'bytes' || item.items[1]?.kind !== 'uint') throw new Error('bad input');
    return { txHash: toHex(item.items[0].value), index: Number(item.items[1].value) };
  });
}

/** The parts of a transaction that the tests and the evaluation read. */
export function readTx(txCborHex: string): {
  id: string;
  inputs: OutputReference[];
  referenceInputs: OutputReference[];
  collateral: OutputReference[];
  requiredSigners: string[];
  redeemers: Array<{ tag: 'spend' | 'mint' | 'withdraw'; index: number }>;
  withdrawals: bigint[];
} {
  const bytes = fromHex(txCborHex);
  const parsed = readCbor(bytes);
  if (parsed.kind !== 'array' || parsed.items.length !== 4) throw new Error('not a Conway transaction');
  const [body, witnessSet] = parsed.items as [Item, Item];
  let signers = entry(body, 14);
  if (signers?.kind === 'tag') signers = signers.item;
  const requiredSigners = signers?.kind === 'array' ? signers.items.map((s) => (s.kind === 'bytes' ? toHex(s.value) : '')) : [];
  const withdrawalMap = entry(body, 5);
  const withdrawals = withdrawalMap?.kind === 'map' ? withdrawalMap.entries.map(([, v]) => (v.kind === 'uint' ? v.value : -1n)) : [];
  const redeemerMap = entry(witnessSet, 5);
  const redeemers = redeemerMap?.kind === 'map'
    ? redeemerMap.entries.map(([k]) => {
      if (k.kind !== 'array' || k.items[0]?.kind !== 'uint' || k.items[1]?.kind !== 'uint') throw new Error('bad redeemer key');
      return { tag: TAGS[Number(k.items[0].value)]!, index: Number(k.items[1].value) };
    })
    : [];
  return {
    id: transactionId(txCborHex),
    inputs: refsAt(body, 0),
    referenceInputs: refsAt(body, 18),
    collateral: refsAt(body, 13),
    requiredSigners,
    redeemers,
    withdrawals,
  };
}

/**
 * The harness view of a transaction: the body bytes stay as built, `keys`
 * add key witnesses, and `encode(order)` writes the redeemers in another
 * order (the transaction ID does not change), so `simulate()` gives each
 * redeemer its own verdict. `utxos` resolves the spent, reference and
 * collateral inputs. With `strict`, every key that must sign needs a key.
 */
export function builtFromCbor(txCborHex: string, utxos: ReadonlyMap<string, ChainUtxo>, keys: readonly KeyPair[] = [], strict = false): BuiltTx {
  const bytes = fromHex(txCborHex);
  const parsed = readCbor(bytes);
  if (parsed.kind !== 'array' || parsed.items.length !== 4) throw new Error('not a Conway transaction');
  const [body, witnessSet] = parsed.items as [Item, Item];
  const slice = (item: { start: number; end: number }): Uint8Array => bytes.slice(item.start, item.end);
  const bodyBytes = slice(body);
  const id = blake2b256(bodyBytes);
  const info = readTx(txCborHex);
  const resolve = (ref: OutputReference): ChainUtxo => {
    const u = utxos.get(refKey(ref));
    if (u === undefined) throw new Error(`unknown UTxO ${refKey(ref)}`);
    return u;
  };
  const needed = new Set(info.requiredSigners);
  for (const ref of [...info.inputs, ...info.collateral]) {
    const credential = paymentCredential(resolve(ref).address);
    if (credential?.type === 'VerificationKey') needed.add(credential.hash);
  }
  const byHash = new Map(keys.map((k) => [toHex(k.keyHash), k]));
  const missing = [...needed].filter((h) => !byHash.has(h));
  if (strict && missing.length > 0) throw new Error(`no test key for signer(s) ${missing.join(', ')}`);
  const vkeys = [...needed].filter((h) => byHash.has(h)).map((h) => {
    const key = byHash.get(h)!;
    return cbor.array([cbor.bytes(key.publicKey), cbor.bytes(Uint8Array.from(nodeSign(null, id, key.privateKey)))]);
  });
  const seen = new Set<string>();
  const resolved: HarnessUtxo[] = [];
  for (const ref of [...info.inputs, ...info.referenceInputs, ...info.collateral]) {
    if (seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    resolved.push(toHarnessUtxo(resolve(ref)));
  }
  if (witnessSet.kind !== 'map') throw new Error('the witness set is not a map');
  const others = witnessSet.entries.filter(([key]) => !(key.kind === 'uint' && key.value === 0n));
  const encode = (order: readonly number[] = info.redeemers.map((_, i) => i)): Uint8Array => {
    const parts: Array<readonly [Uint8Array, Uint8Array]> = [];
    if (vkeys.length > 0) parts.push([cbor.uint(0), cbor.tag(258, cbor.array(vkeys))]);
    for (const [key, value] of others) {
      if (key.kind === 'uint' && key.value === 5n && value.kind === 'map') {
        parts.push([slice(key), cbor.map(order.map((position) => {
          const pair = value.entries[position];
          if (pair === undefined) throw new Error(`no redeemer ${position}`);
          return [slice(pair[0]), slice(pair[1])] as const;
        }))]);
      } else {
        parts.push([slice(key), slice(value)]);
      }
    }
    return cbor.array([bodyBytes, cbor.map(parts), cbor.TRUE, cbor.NULL]);
  };
  return {
    spec: { inputs: [], outputs: [], fee: 0n },
    id,
    body: bodyBytes,
    redeemers: info.redeemers.map((r) => ({ ...r, data: 0n, label: `${r.tag}:${r.index}` })),
    resolved,
    encode,
    utxo: () => {
      throw new Error('not available');
    },
  };
}

// ─── aiken ──────────────────────────────────────────────────────────

/** True when `aiken` v1.1.21 is on PATH. */
export function aikenAvailable(): boolean {
  const result = spawnSync('aiken', ['--version'], { encoding: 'utf8' });
  return result.status === 0 && /v1\.1\.21\b/.test(result.stdout);
}

/** Runs `aiken tx simulate` on a transaction; `keys` sign it (strict: every needed key). */
export function simulateTx(txCborHex: string, utxos: ReadonlyMap<string, ChainUtxo>, keys: readonly KeyPair[]): Simulation {
  return simulate(builtFromCbor(txCborHex, utxos, keys, true));
}

// ─── The in-memory chain ────────────────────────────────────────────

/** Units for each redeemer of a transaction, without running a script. */
export function fixedEvaluator(mem = 1_000_000n, steps = 400_000_000n): (txCborHex: string) => RedeemerUnits {
  return (txCborHex) => Object.fromEntries(readTx(txCborHex).redeemers.map((r) => [`${r.tag}:${r.index}`, { mem, steps }]));
}

/** An evaluator that runs the real scripts with `aiken tx simulate`, as Ogmios evaluates them. */
export function aikenEvaluator(chain: FakeChain): (txCborHex: string) => RedeemerUnits {
  return (txCborHex) => {
    const built = builtFromCbor(txCborHex, chain.utxos);
    const result = simulate(built);
    if (!result.passed) throw new TransactionError(`aiken: ${result.failedAt ?? ''}: ${result.error ?? ''}`);
    return Object.fromEntries(built.redeemers.map((r, i) => [
      `${r.tag}:${r.index}`,
      { mem: BigInt(result.verdicts[i]!.mem!), steps: BigInt(result.verdicts[i]!.cpu!) },
    ]));
  };
}

/** An `IdentityChain` over an in-memory UTxO set. `apply` spends a built transaction's inputs and adds its outputs. */
export class FakeChain implements IdentityChain {
  readonly utxos = new Map<string, ChainUtxo>();
  readonly rewardBalances = new Map<string, bigint>();
  readonly calls: string[] = [];
  readonly submitted: string[] = [];
  tipSlot = TEST_TIP_SLOT;
  slotConfig: SlotConfig = VECTOR_MAINNET_SLOT_CONFIG;
  protocol: LucidProtocolParameters = TEST_PROTOCOL;
  evaluator: (txCborHex: string) => RedeemerUnits = fixedEvaluator();

  add(...utxos: ChainUtxo[]): void {
    for (const u of utxos) this.utxos.set(refKey(u.ref), u);
  }

  apply(tx: UnsignedTx): void {
    for (const ref of tx.inputs) {
      if (!this.utxos.delete(refKey(ref))) throw new Error(`the transaction spends an unknown output ${refKey(ref)}`);
    }
    this.add(...tx.outputs);
  }

  /** Moves the tip by `seconds`. */
  advance(seconds: number): void {
    this.tipSlot += seconds;
  }

  async getProtocolParameters(): Promise<LucidProtocolParameters> {
    this.calls.push('protocol');
    return this.protocol;
  }

  async getTipSlot(): Promise<number> {
    this.calls.push('tip');
    return this.tipSlot;
  }

  async getSlotConfig(): Promise<SlotConfig> {
    this.calls.push('slots');
    return this.slotConfig;
  }

  async queryUtxosAt(addr: string): Promise<ChainUtxo[]> {
    return [...this.utxos.values()].filter((u) => u.address === addr);
  }

  async queryUtxosByRefs(refs: readonly OutputReference[]): Promise<ChainUtxo[]> {
    return refs.flatMap((r) => {
      const u = this.utxos.get(refKey(r));
      return u === undefined ? [] : [u];
    });
  }

  async queryTokenUtxos(policyId: string, assetName: string): Promise<ChainUtxo[]> {
    return [...this.utxos.values()].filter((u) => (u.assets[`${policyId}${assetName}`] ?? 0n) > 0n);
  }

  async getRewardBalance(scriptHash: string): Promise<bigint | null> {
    this.calls.push(`reward:${scriptHash}`);
    return this.rewardBalances.get(scriptHash) ?? null;
  }

  async evaluateRedeemers(txCborHex: string): Promise<RedeemerUnits> {
    this.calls.push('evaluate');
    return this.evaluator(txCborHex);
  }

  async submitTx(txCborHex: string): Promise<string> {
    this.submitted.push(txCborHex);
    return transactionId(txCborHex);
  }
}
