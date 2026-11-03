/**
 * IdentityRegistry: every identity-registry operation (Part 2 §3, did:vector
 * Part 1 §6) over the vendored builders: register (also subagents), adopt,
 * update, change controller, suspend, unsuspend, revoke, retire, reclaim,
 * set successor, start, cancel and complete recovery, and end subagents.
 *
 * Each builder reads the record and the other outputs it needs from the
 * chain, builds an unsigned transaction and returns it with every key hash
 * that must sign (`requiredSigners`). The SDK never holds keys: sign with
 * `signTransaction` or your own signer, then `IdentityContext.submit`.
 *
 * Module-1 acts only through a consent in Register, Adopt and Update. When a
 * builder needs the consent, the client adds the Module-1 script
 * (`VECTOR_MODULE1_REF_UTXO`) and withdraws the whole reward balance of
 * Module-1, read from the chain just before the build.
 */
import type { BuildOptions, IdentityContext } from './context.js';
import { toVectorId } from './ids.js';
import type { AgentView, DidResolution, ResolveOptions } from './gateway.js';
import { IdentityLookupError, ruleError } from './errors.js';
import {
  buildAdopt,
  buildBumpEpoch,
  buildChangeController,
  buildReclaim,
  buildRecoverCancel,
  buildRecoverFinalize,
  buildRecoverInit,
  buildRegister,
  buildRetire,
  buildRevoke,
  buildSetSuccessor,
  buildSuspend,
  buildUnsuspend,
  buildUpdate,
  isEnterpriseAddressOf,
  ROLE_MAX_RIGHTS,
  TxConstructionError,
  utf8ToHex,
  utxoAssets,
  vectorIdFromSeed,
  type Actor,
  type CreatedRecordTx,
  type IdentityScripts,
  type Key,
  type OutputReference,
  type Party,
  type Profile,
  type RecordUtxo,
  type Role,
  type Signer,
  type TxContext,
  type UnsignedTx,
} from './vendor.js';

/** The `ControllerSet` signer: whoever is the record's controller. */
export const CONTROLLER_SET: Signer = { type: 'ControllerSet' };

/** A key-hash signer (28-byte hash, hex). */
export function keyHashSigner(hash: string): Signer {
  return { type: 'KeyHash', hash };
}

/** The Module-1 signer (`Script { hash: M1 }`), the only script party (Part 2 §3.8). */
export function module1Signer(m1: string): Signer {
  return { type: 'Script', hash: m1 };
}

export interface PartySpecInit {
  role: Role;
  signer: Signer;
  /** Bits 1 suspend, 2 revoke, 4 recover. Default: the role's highest rights. */
  rights?: number;
  /** UTF-8 DID or domain of an organisation (1..64 bytes), never a person. */
  organisation?: string | null;
  /** Default: the lower bound of the transaction's validity range, so the party covers it. */
  notBefore?: number;
  notAfter?: number | null;
  removalAfter?: number | null;
}

/**
 * A new party, given before the validity range is known. A `Party` (record
 * format, organisation as hex) is used as it is; a `PartySpec` becomes one
 * when the client builds.
 */
export class PartySpec {
  readonly role: Role;
  readonly signer: Signer;
  readonly rights: number | undefined;
  readonly organisation: string | null;
  readonly notBefore: number | undefined;
  readonly notAfter: number | null;
  readonly removalAfter: number | null;

  constructor(init: PartySpecInit) {
    this.role = init.role;
    this.signer = init.signer;
    this.rights = init.rights;
    this.organisation = init.organisation ?? null;
    this.notBefore = init.notBefore;
    this.notAfter = init.notAfter ?? null;
    this.removalAfter = init.removalAfter ?? null;
  }

  toParty(lo: number): Party {
    return {
      role: this.role,
      signer: this.signer,
      organisation: this.organisation === null ? null : utf8ToHex(this.organisation),
      notBefore: this.notBefore ?? lo,
      notAfter: this.notAfter,
      rights: this.rights ?? ROLE_MAX_RIGHTS[this.role],
      removalAfter: this.removalAfter,
    };
  }
}

const toParties = (parties: ReadonlyArray<Party | PartySpec>, lo: number): Party[] =>
  parties.map((p) => (p instanceof PartySpec ? p.toParty(lo) : p));

export interface RegisterOptions extends BuildOptions {
  /** The controller's Ed25519 public key (32 bytes, hex). It signs. */
  controller: string;
  name: string;
  /** At least one Accountable party that covers the validity range. Each party signs (or consents). */
  parties: ReadonlyArray<Party | PartySpec>;
  /** Listed keys (`ed25519Key`, `p256Key`). Each new Ed25519 key signs. */
  keys?: Key[];
  description?: string;
  framework?: string;
  /** Must be empty for a subagent. */
  endpoint?: string;
  capabilities?: string[];
  guardianThreshold?: number;
  /** The parent agent (identifier or DID): the new record is its subagent. The parent's controller signs. */
  parent?: string;
  /** Default: the funding output with the lowest reference (`nextIdentifier`). */
  seed?: OutputReference;
  /** The record output's AP3X (default and minimum 10 AP3X; raised to the ledger minimum). */
  deposit?: bigint;
}

export interface AdoptOptions extends BuildOptions {
  /** The legacy record: its identifier or DID. */
  agent: string;
  controller: string;
  parties: ReadonlyArray<Party | PartySpec>;
  keys?: Key[];
  /** The published allowlist (every identifier); the builder makes the Merkle proof. */
  allowlist: readonly string[];
  /** New profile values; each legacy field that breaks a record limit needs one. */
  profile?: Partial<Profile>;
  guardianThreshold?: number;
  /** Where the 10 AP3X of the legacy change rule go (default: the legacy owner's enterprise address). */
  ownerAddress?: string;
  deposit?: bigint;
}

export interface UpdateOptions extends BuildOptions {
  agent: string;
  /** Profile fields to change. */
  profile?: Partial<Profile>;
  /** The complete new key list. A kept key keeps its type, purposes and proof. */
  keys?: Key[];
  /**
   * The complete new party list. Keep a party by passing the record's
   * `Party`; give a removal notice with `{ ...party, removalAfter: t }`
   * (`t ≥ hi + 7 days`); new parties come last.
   */
  parties?: ReadonlyArray<Party | PartySpec>;
  guardianThreshold?: number;
  /** The record output's AP3X (default: as spent; at least 10 AP3X). */
  deposit?: bigint;
}

export interface SpendOptions extends BuildOptions {
  /** The record: its identifier or DID. */
  agent: string;
}

/** Builders for every identity-registry operation, and record reads. */
export class IdentityRegistry {
  constructor(readonly ctx: IdentityContext) {}

  // ─── Reads ──────────────────────────────────────────────────────────

  /** The current record output (live record or tombstone) from the ledger. */
  async record(agent: string): Promise<RecordUtxo> {
    return this.ctx.record(toVectorId(agent));
  }

  async findRecord(agent: string): Promise<RecordUtxo | null> {
    return this.ctx.findRecord(toVectorId(agent));
  }

  /** DID resolution through the gateway (Part 1 §7.4). */
  async resolve(did: string, options?: ResolveOptions): Promise<DidResolution> {
    return this.ctx.gateway.resolve(did, options);
  }

  /** The gateway's view of an agent without version options. */
  async currentRecord(agent: string): Promise<AgentView> {
    return this.ctx.gateway.currentRecord(agent);
  }

  /**
   * The seed that a registration from `fundingAddress` spends by default,
   * and the identifier it gives. Use it when a key must sign over the
   * identifier before the registration (the P-256 `pop`).
   */
  async nextIdentifier(fundingAddress: string): Promise<{ seed: OutputReference; vectorId: string }> {
    const seed = await this.ctx.seedOf(fundingAddress);
    return { seed: seed.ref, vectorId: vectorIdFromSeed(seed.ref.txHash, seed.ref.index) };
  }

  // ─── Shared steps ───────────────────────────────────────────────────

  /**
   * Builds an identity transaction. A first build without Module-1 checks the
   * rules; when it shows that Module-1 must consent, the client adds the
   * Module-1 script and its reward balance and builds again.
   */
  private async build<S extends IdentityScripts, T extends UnsignedTx>(
    options: BuildOptions,
    tx: TxContext,
    scripts: (withModule1: boolean) => Promise<S>,
    build: (ctx: TxContext, scripts: S) => T,
  ): Promise<T> {
    let chosen = await scripts(false);
    let base = tx;
    try {
      build(base, chosen);
    } catch (error) {
      if (!(error instanceof TxConstructionError) || error.reason !== 'module1_script_missing') throw error;
      const [withModule1, rewardBalances] = await Promise.all([scripts(true), this.ctx.module1RewardBalance()]);
      chosen = withModule1;
      base = { ...tx, rewardBalances };
    }
    return this.ctx.complete(base, (ctx) => build(ctx, chosen), options.evaluate);
  }

  private async spend(
    options: SpendOptions,
    build: (ctx: TxContext, scripts: IdentityScripts, record: RecordUtxo, window: { lo: number; hi: number }) => UnsignedTx,
  ): Promise<UnsignedTx> {
    const [record, prepared] = await Promise.all([this.record(options.agent), this.ctx.prepare(options)]);
    return this.build(options, prepared.tx, (m1) => this.ctx.identityScripts(m1), (ctx, scripts) => build(ctx, scripts, record, prepared.window));
  }

  private async recordUtxo(agent: string, label: string): Promise<RecordUtxo> {
    const found = await this.findRecord(agent);
    if (found === null) throw new IdentityLookupError(`${label}: no identity record for ${agent}`);
    return found;
  }

  // ─── Create (§3.4) ──────────────────────────────────────────────────

  /** Register a new record; with `parent`, a subagent of that record. The new identifier is `id`. */
  async register(options: RegisterOptions): Promise<CreatedRecordTx> {
    const [prepared, seed] = await Promise.all([this.ctx.prepare(options), this.ctx.seedOf(options.fundingAddress, options.seed)]);
    let parent: { record: RecordUtxo['utxo']; ancestors: Array<RecordUtxo['utxo']> } | undefined;
    if (options.parent !== undefined) {
      const record = await this.recordUtxo(options.parent, 'parent');
      const ancestors = await this.ctx.ancestors(record.datum);
      parent = { record: record.utxo, ancestors: ancestors.map((a) => a.utxo) };
    }
    const { window } = prepared;
    const args = {
      seed,
      window,
      controller: options.controller,
      keys: options.keys ?? [],
      parties: toParties(options.parties, window.lo),
      guardianThreshold: options.guardianThreshold ?? 0,
      profile: {
        name: options.name,
        description: options.description ?? '',
        framework: options.framework ?? '',
        endpoint: options.endpoint ?? '',
        capabilities: options.capabilities ?? [],
      },
      ...(options.deposit === undefined ? {} : { deposit: options.deposit }),
      ...(parent === undefined ? {} : { parent }),
    };
    return this.build(options, prepared.tx, (m1) => this.ctx.identityScripts(m1), (ctx, scripts) => buildRegister(ctx, scripts, args));
  }

  /**
   * Adopt a legacy record (§3.4, §9.1): the legacy Deregister and Burn and
   * the identity mint with the same identifier, in one transaction. The
   * legacy owner key, the controller, each new Ed25519 key and each party sign.
   */
  async adopt(options: AdoptOptions): Promise<CreatedRecordTx> {
    const vectorId = toVectorId(options.agent);
    const scripts = this.ctx.scripts;
    const [prepared, candidates] = await Promise.all([
      this.ctx.prepare(options),
      this.ctx.chain.queryTokenUtxos(scripts.legacyHash, vectorId),
    ]);
    const legacyRecord = candidates.find((u) => isEnterpriseAddressOf(u.address, { type: 'Script', hash: scripts.legacyHash })
      && utxoAssets(u).filter((a) => a.policy === scripts.legacyHash).length === 1);
    if (legacyRecord === undefined) throw new IdentityLookupError(`no legacy record for ${vectorId} at the legacy registry address`);
    const { window } = prepared;
    const args = {
      legacyRecord,
      allowlist: options.allowlist,
      window,
      controller: options.controller,
      keys: options.keys ?? [],
      parties: toParties(options.parties, window.lo),
      guardianThreshold: options.guardianThreshold ?? 0,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.ownerAddress === undefined ? {} : { ownerAddress: options.ownerAddress }),
      ...(options.deposit === undefined ? {} : { deposit: options.deposit }),
    };
    return this.build(options, prepared.tx, (m1) => this.ctx.adoptionScripts(m1), (ctx, s) => buildAdopt(ctx, s, args));
  }

  // ─── Update (§3.6) ──────────────────────────────────────────────────

  /** Change the profile, the keys, the parties or the guardian threshold. */
  async update(options: UpdateOptions): Promise<UnsignedTx> {
    if (options.profile === undefined && options.keys === undefined && options.parties === undefined
      && options.guardianThreshold === undefined && options.deposit === undefined) {
      ruleError('update_empty', 'the update changes nothing');
    }
    return this.spend(options, (ctx, scripts, record, window) => buildUpdate(ctx, scripts, {
      record: record.utxo,
      window,
      ...(options.keys === undefined ? {} : { keys: options.keys }),
      ...(options.parties === undefined ? {} : { parties: toParties(options.parties, window.lo) }),
      ...(options.guardianThreshold === undefined ? {} : { guardianThreshold: options.guardianThreshold }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.deposit === undefined ? {} : { deposit: options.deposit }),
    }));
  }

  /** Install a new controller key (old and new controllers sign). Ends all subagents and a pending recovery. */
  async changeController(options: SpendOptions & { newController: string; deposit?: bigint }): Promise<UnsignedTx> {
    return this.spend(options, (ctx, scripts, record, window) => buildChangeController(ctx, scripts, {
      record: record.utxo,
      window,
      newController: options.newController,
      ...(options.deposit === undefined ? {} : { deposit: options.deposit }),
    }));
  }

  /** `BumpEpoch`: every subagent created under an older epoch ends. */
  async endSubagents(options: SpendOptions & { deposit?: bigint }): Promise<UnsignedTx> {
    return this.spend(options, (ctx, scripts, record, window) => buildBumpEpoch(ctx, scripts, {
      record: record.utxo,
      window,
      ...(options.deposit === undefined ? {} : { deposit: options.deposit }),
    }));
  }

  // ─── Holds (§3.5) ───────────────────────────────────────────────────

  /**
   * Add or renew the author's own hold: by the controller, or by the party
   * at index `byParty` (suspend right). `until` or `durationMs` (from lo)
   * sets its end: `hi < until ≤ lo + 30 days`.
   */
  async suspend(options: SpendOptions & { reason: number; until?: number; durationMs?: number; byParty?: number }): Promise<UnsignedTx> {
    if ((options.until === undefined) === (options.durationMs === undefined)) {
      ruleError('hold_until', 'give exactly one of until and durationMs');
    }
    const actor: Actor = options.byParty === undefined ? { type: 'ByController' } : { type: 'ByParty', index: options.byParty };
    return this.spend(options, (ctx, scripts, record, window) => buildSuspend(ctx, scripts, {
      record: record.utxo,
      window,
      actor,
      reason: options.reason,
      until: options.until ?? window.lo + (options.durationMs ?? 0),
    }));
  }

  /** Remove the hold of `author` (the controller set, or a party's key hash). The author signs. */
  async unsuspend(options: SpendOptions & { author: Signer }): Promise<UnsignedTx> {
    return this.spend(options, (ctx, scripts, record, window) => buildUnsuspend(ctx, scripts, { record: record.utxo, window, author: options.author }));
  }

  // ─── Final actions and successors (§3.7) ────────────────────────────

  /**
   * Revoke: by the controller, or by the party at index `byParty` (revoke
   * right). `invalidFrom` is in `[created_at, lo]`; reason 1 requires it.
   * Only the controller names a successor (a live Root record; its controller signs).
   */
  async revoke(options: SpendOptions & { reason: number; byParty?: number; invalidFrom?: number | null; successor?: string }): Promise<UnsignedTx> {
    const actor: Actor = options.byParty === undefined ? { type: 'ByController' } : { type: 'ByParty', index: options.byParty };
    const successor = options.successor === undefined ? undefined : await this.recordUtxo(options.successor, 'successor');
    return this.spend(options, (ctx, scripts, record, window) => buildRevoke(ctx, scripts, {
      record: record.utxo,
      window,
      actor,
      reason: options.reason,
      invalidFrom: options.invalidFrom ?? null,
      ...(successor === undefined ? {} : { successor: successor.utxo }),
    }));
  }

  /** Retire: the controller's tombstone. The AP3X above `recordCoin` (default: the ledger minimum) goes to the change address. */
  async retire(options: SpendOptions & { successor?: string; recordCoin?: bigint }): Promise<UnsignedTx> {
    const successor = options.successor === undefined ? undefined : await this.recordUtxo(options.successor, 'successor');
    return this.spend(options, (ctx, scripts, record, window) => buildRetire(ctx, scripts, {
      record: record.utxo,
      window,
      ...(successor === undefined ? {} : { successor: successor.utxo }),
      ...(options.recordCoin === undefined ? {} : { recordCoin: options.recordCoin }),
    }));
  }

  /** Reclaim: the controller of a tombstone takes the AP3X above `recordCoin` (default: the ledger minimum). */
  async reclaim(options: SpendOptions & { recordCoin?: bigint }): Promise<UnsignedTx> {
    return this.spend(options, (ctx, scripts, record, window) => buildReclaim(ctx, scripts, {
      record: record.utxo,
      window,
      ...(options.recordCoin === undefined ? {} : { recordCoin: options.recordCoin }),
    }));
  }

  /** SetSuccessor: the controller of a tombstone without a successor names one. */
  async setSuccessor(options: SpendOptions & { successor: string }): Promise<UnsignedTx> {
    const successor = await this.recordUtxo(options.successor, 'successor');
    return this.spend(options, (ctx, scripts, record, window) => buildSetSuccessor(ctx, scripts, { record: record.utxo, window, successor: successor.utxo }));
  }

  // ─── Recovery (§3.5) ────────────────────────────────────────────────

  /** RecoverInit: guardians (party indices) start a recovery to `newController`, which signs. */
  async startRecovery(options: SpendOptions & { guardians: number[]; newController: string }): Promise<UnsignedTx> {
    return this.spend(options, (ctx, scripts, record, window) => buildRecoverInit(ctx, scripts, {
      record: record.utxo,
      window,
      guardians: options.guardians,
      newController: options.newController,
    }));
  }

  /** RecoverCancel: guardians end a pending recovery. */
  async cancelRecovery(options: SpendOptions & { guardians: number[] }): Promise<UnsignedTx> {
    return this.spend(options, (ctx, scripts, record, window) => buildRecoverCancel(ctx, scripts, { record: record.utxo, window, guardians: options.guardians }));
  }

  /** RecoverFinalize: anybody, 7 days after the start; installs the new controller and ends the subagents. */
  async completeRecovery(options: SpendOptions): Promise<UnsignedTx> {
    return this.spend(options, (ctx, scripts, record, window) => buildRecoverFinalize(ctx, scripts, { record: record.utxo, window }));
  }
}
