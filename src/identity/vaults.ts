/**
 * Vaults (Part 2 §5.3): open, pay and close over the vendored builders.
 *
 * A vault holds AP3X of an owner (a principal key or an agent) for one
 * delegation. `pay` lets the delegation's delegate post new escrows (§6.1)
 * from the vault within the delegation's value limit. Each escrow output
 * holds exactly payment + buyer bond + supplier bond; when that sum is below
 * the ledger minimum of the output, the buyer bond takes the difference.
 * Escrow refunds return to the vault as `Returned` outputs, which only the
 * owner can close.
 *
 * `pay` copies each escrow from a listed new advert (§6.2): the advert is at
 * the new advert address and Active, its agent record is independent,
 * Active, lists the supplier key with the transaction purpose and the
 * capability, and the transaction that created the advert lists the supplier
 * key as a required signer. The last check needs the marketplace indexer
 * (`VECTOR_MARKETPLACE_INDEXER_URL`, `GET /suppliers/{pkh}`) or an
 * `advertListed` callback.
 */
import { sha256 } from '@noble/hashes/sha256';
import crossFetch from 'cross-fetch';
import { z } from 'zod';
import type { ChainUtxo } from '../chain/identity-chain.js';
import { ConnectionError } from '../errors.js';
import { WINDOW_BACKPAD_MS, type BuildOptions, type IdentityContext } from './context.js';
import { Delegations } from './delegations.js';
import { IdentityLookupError, ruleError } from './errors.js';
import {
  activeKey,
  buildVaultClose,
  buildVaultOpen,
  buildVaultPay,
  bytesToHex,
  canonicalize,
  datumMap,
  decodeIdentityAdvertDatum,
  decodeVaultDatum,
  effectiveStatus,
  isEnterpriseAddressOf,
  PURPOSE_TRANSACTION,
  utf8ToHex,
  type Delegator,
  type IdentityAdvertDatum,
  type OutputReference,
  type UnsignedTx,
  type VaultDatum,
  type VaultEscrowJob,
} from './vendor.js';

/** `deliver_by = posted_at + max_processing_ms + NETWORK_BUFFER_MS`, as the marketplace Post builders set it. */
export const NETWORK_BUFFER_MS = 30_000;

/** SHA-256 (hex) of the canonical JSON `{capability_id, max_output_tokens, model}` of an advert. */
export function requestSpecHash(advert: Pick<IdentityAdvertDatum, 'capability_id' | 'max_output_tokens' | 'model'>): string {
  const spec = { capability_id: advert.capability_id, max_output_tokens: advert.max_output_tokens, model: advert.model };
  return bytesToHex(sha256(new TextEncoder().encode(canonicalize(spec))));
}

/** One escrow that a vault payment posts: the advert to hire and the prompt commitment (32 bytes, hex). */
export interface VaultJob {
  advertRef: OutputReference;
  promptHash: string;
}

/** Decides whether an advert is listed (the creating transaction listed the supplier key as a required signer). */
export type AdvertListed = (advertRef: OutputReference, advert: IdentityAdvertDatum) => Promise<boolean> | boolean;

export interface VaultOutput {
  utxo: ChainUtxo;
  datum: VaultDatum;
}

const sameDelegator = (a: Delegator, b: Delegator): boolean =>
  a.type === 'PrincipalKey' && b.type === 'PrincipalKey'
    ? a.hash === b.hash && a.organisation === b.organisation
    : a.type === 'Agent' && b.type === 'Agent' && a.id === b.id;

const supplierRow = z.object({ utxo_ref: z.string().optional(), agent_id: z.string().nullable().optional() }).passthrough();

/** Builders for the vault contract, and vault reads. */
export class Vaults {
  private readonly advertListed: AdvertListed | undefined;
  private readonly fetchImpl: typeof crossFetch;

  constructor(readonly ctx: IdentityContext, options: { advertListed?: AdvertListed; fetch?: typeof crossFetch } = {}) {
    this.advertListed = options.advertListed;
    this.fetchImpl = options.fetch ?? crossFetch;
  }

  /** A vault output by reference. */
  async get(vaultRef: OutputReference): Promise<VaultOutput> {
    const utxo = await this.ctx.utxo(vaultRef, 'vault output');
    if (!isEnterpriseAddressOf(utxo.address, { type: 'Script', hash: this.ctx.scripts.vault.hash })) {
      throw new IdentityLookupError(`${vaultRef.txHash}#${vaultRef.index} is not at the vault address`);
    }
    if (utxo.datumHex === null) throw new IdentityLookupError(`the vault output ${vaultRef.txHash}#${vaultRef.index} has no inline datum`);
    return { utxo, datum: decodeVaultDatum(utxo.datumHex) };
  }

  /** The vault outputs, all or those of `owner`. */
  async list(owner?: Delegator): Promise<VaultOutput[]> {
    const out: VaultOutput[] = [];
    for (const utxo of await this.ctx.chain.queryUtxosAt(this.ctx.scripts.vault.address)) {
      if (utxo.datumHex === null) continue;
      let datum: VaultDatum;
      try {
        datum = decodeVaultDatum(utxo.datumHex);
      } catch {
        continue;
      }
      if (owner === undefined || sameDelegator(datum.owner, owner)) out.push({ utxo, datum });
    }
    return out;
  }

  /**
   * Lock `amount` base units for the delegation `delegationId` of `owner`.
   * The delegation names `owner` as delegator, has a value limit and covers
   * the action `marketplace.hire.v1` and the escrow resource.
   */
  async open(options: BuildOptions & { owner: Delegator; delegationId: string; amount: bigint }): Promise<UnsignedTx & { vaultOutput: number }> {
    const [delegation, prepared, scripts] = await Promise.all([
      this.ctx.delegation(options.delegationId),
      this.ctx.prepare(options),
      this.ctx.vaultScripts(),
    ]);
    return this.ctx.complete(prepared.tx, (ctx) => buildVaultOpen(ctx, scripts, {
      owner: options.owner,
      delegation: delegation.utxo,
      amount: options.amount,
      window: prepared.window,
    }), options.evaluate);
  }

  /** The listing rule of the indexer: a row with this advert reference and agent. */
  private async listedByIndexer(advertRef: OutputReference, advert: IdentityAdvertDatum): Promise<boolean> {
    const base = this.ctx.config.indexerUrl;
    if (base === null) {
      ruleError('advert_listing_unknown', 'the listing rule (Part 2 §6.2) needs the signers of the creating transaction: '
        + 'set VECTOR_MARKETPLACE_INDEXER_URL or pass advertListed to Vaults');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}/suppliers/${advert.supplier_pkh}`, { headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new ConnectionError(`indexer request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.status === 404) return false;
    if (!response.ok) throw new ConnectionError(`indexer answered HTTP ${response.status}`);
    const body: unknown = await response.json();
    const rows = z.array(supplierRow).safeParse(Array.isArray(body) ? body : [body]);
    if (!rows.success) throw new ConnectionError('the indexer answer is not a list of supplier rows');
    const ref = `${advertRef.txHash}#${advertRef.index}`;
    return rows.data.some((row) => row.utxo_ref?.toLowerCase() === ref && row.agent_id === advert.agent_id);
  }

  /** A listed new advert (§6.2) whose agent can take work over `[lo, hi]`. */
  private async listedAdvert(ref: OutputReference, lo: number, hi: number): Promise<IdentityAdvertDatum> {
    const where = `advert ${ref.txHash}#${ref.index}`;
    const utxo = await this.ctx.utxo(ref, 'advert');
    if (!isEnterpriseAddressOf(utxo.address, { type: 'Script', hash: this.ctx.scripts.advert.hash })) {
      ruleError('advert_not_listed', `${where} is not at the new advert address`);
    }
    if (utxo.datumHex === null) ruleError('advert_not_listed', `${where} has no inline datum`);
    const advert = decodeIdentityAdvertDatum(utxo.datumHex);
    if (advert.status !== 'Active') ruleError('advert_retired', `${where} is retired`);
    const record = await this.ctx.record(advert.agent_id);
    if (record.datum.lineage.type !== 'Root') ruleError('advert_agent_subagent', `the agent of ${where} is a subagent`);
    const status = effectiveStatus(record.datum, datumMap([]), lo, hi);
    if (status !== 'Active') ruleError('advert_agent_not_active', `the agent of ${where} is ${status}`);
    if (!activeKey(record.datum, advert.supplier_pkh, PURPOSE_TRANSACTION)) {
      ruleError('advert_key_not_listed', `the agent of ${where} does not list the supplier key with the transaction purpose`);
    }
    if (!record.datum.capabilities.includes(utf8ToHex(advert.capability_id))) {
      ruleError('advert_capability_missing', `the agent of ${where} does not list the capability ${advert.capability_id}`);
    }
    const listed = this.advertListed === undefined ? await this.listedByIndexer(ref, advert) : await this.advertListed(ref, advert);
    if (!listed) ruleError('advert_not_listed', `${where} is not listed (Part 2 §6.2)`);
    return advert;
  }

  /**
   * Post one new escrow per job from the vault; the delegation's delegate
   * key signs. Each escrow copies its advert (supplier, capability, price,
   * bonds, `agent_id`), names the delegate key as buyer and the vault as
   * refund address. The funding address pays only the fee.
   */
  async pay(options: BuildOptions & { vault: OutputReference; jobs: VaultJob[] }): Promise<UnsignedTx & { escrowOutputs: number[]; vaultOutput: number }> {
    if (options.jobs.length === 0) ruleError('vault_no_escrow', 'a payment posts at least one escrow');
    const vault = await this.get(options.vault);
    if (vault.datum.type !== 'Live') ruleError('vault_returned', 'only a Live vault output pays; Returned outputs only close');
    const [prepared, scripts, use] = await Promise.all([
      this.ctx.prepare(options),
      this.ctx.vaultScripts(),
      new Delegations(this.ctx).useInputs(vault.datum.delegation),
    ]);
    const { lo, hi } = prepared.window;
    const postedAt = lo + WINDOW_BACKPAD_MS;
    const escrows: VaultEscrowJob[] = [];
    for (const job of options.jobs) {
      const advert = await this.listedAdvert(job.advertRef, lo, hi);
      escrows.push({
        supplierPkh: advert.supplier_pkh,
        advertRef: job.advertRef,
        capabilityId: advert.capability_id,
        requestSpecHash: requestSpecHash(advert),
        promptHash: job.promptHash.toLowerCase(),
        payment: advert.price_lovelace,
        buyerBond: advert.buyer_bond_lovelace,
        supplierBond: advert.supplier_bond_lovelace,
        deliverBy: postedAt + advert.max_processing_ms + NETWORK_BUFFER_MS,
        postedAt,
        agentId: advert.agent_id,
      });
    }
    return this.ctx.complete(prepared.tx, (ctx) => buildVaultPay(ctx, scripts, {
      vault: vault.utxo,
      window: prepared.window,
      delegation: use.leaf.utxo,
      ancestors: use.ancestors,
      records: use.records,
      escrows,
    }), options.evaluate);
  }

  /**
   * Close Live or Returned vault outputs (also after Undelegate). The owner
   * signs: the principal key, or the agent's controller. The funds go to
   * `to`, or to the change address.
   */
  async close(options: BuildOptions & { vaults: OutputReference[]; to?: string }): Promise<UnsignedTx> {
    if (options.vaults.length === 0) ruleError('vault_missing', 'give at least one vault output');
    const vaults = await Promise.all(options.vaults.map((ref) => this.get(ref)));
    const agents = [...new Set(vaults.flatMap((v) => (v.datum.owner.type === 'Agent' ? [v.datum.owner.id] : [])))];
    const [prepared, scripts, ownerRecords] = await Promise.all([
      this.ctx.prepare(options),
      this.ctx.vaultScripts(),
      Promise.all(agents.map((id) => this.ctx.record(id).then((r) => r.utxo))),
    ]);
    return this.ctx.complete(prepared.tx, (ctx) => buildVaultClose(ctx, scripts, {
      vaults: vaults.map((v) => v.utxo),
      window: prepared.window,
      ownerRecords,
      ...(options.to === undefined ? {} : { to: options.to }),
    }), options.evaluate);
  }
}
