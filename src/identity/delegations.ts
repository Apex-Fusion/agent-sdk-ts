/**
 * Delegations (Part 2 §5.1–§5.2): delegate and undelegate over the vendored
 * builders, the off-chain use checks of a dependent contract, and the fresh
 * key rule: the SDK refuses a `delegate_key` that another live delegation
 * uses (§5.2), so one agent holds at most 8 live delegations.
 */
import type { ChainUtxo } from '../chain/identity-chain.js';
import type { BuildOptions, IdentityContext } from './context.js';
import { ruleError } from './errors.js';
import { toVectorId } from './ids.js';
import {
  buildDelegate,
  buildUndelegate,
  delegationUse,
  utf8ToHex,
  type DelegateTx,
  type DelegationUtxo,
  type Delegator,
  type OutputReference,
  type UnsignedTx,
  type ValidityWindow,
  type ValueLimit,
} from './vendor.js';

/** A principal key delegator (28-byte key hash, hex) with an optional organisation (UTF-8 DID or domain, 1..64 bytes). */
export function principalKeyDelegator(hash: string, organisation: string | null = null): Delegator {
  return { type: 'PrincipalKey', hash, organisation: organisation === null ? null : utf8ToHex(organisation) };
}

/** An agent delegator (identifier or DID). */
export function agentDelegator(agent: string): Delegator {
  return { type: 'Agent', id: toVectorId(agent, 'delegator') };
}

export interface DelegateOptions extends BuildOptions {
  /**
   * The delegator of a delegation without a parent (`principalKeyDelegator`
   * or `agentDelegator`). A principal key signs; for an agent, its
   * controller or `delegatorKeyHash` (a listed key with the delegation purpose)
   * signs. With `parent`, leave it out: the parent's delegate agent delegates
   * and the parent's delegate key signs.
   */
  delegator?: Delegator;
  delegatorKeyHash?: string;
  /** The parent delegation (token name) of a sub-delegation. */
  parent?: string;
  /** The delegate agent: identifier or DID. */
  delegate: string;
  /** Key hash of a fresh Ed25519 key of the delegate with the delegation purpose. It signs. */
  delegateKey: string;
  /** Action patterns (§5.1), 1..16. */
  actions: string[];
  /** Resource patterns (§5.1), 0..8. */
  resources?: string[];
  /** Default: the lower bound of the validity range. */
  notBefore?: number;
  notAfter: number;
  /** Further hops below this one (default 0); depth + remaining ≤ 4. */
  remaining?: number;
  /** 32 bytes (hex): hash of a purpose text or mandate. */
  purpose?: string | null;
  value?: ValueLimit | null;
  seed?: OutputReference;
}

/** The outputs that the use checks of a delegation read (§5.2). */
export interface DelegationUseInputs {
  leaf: DelegationUtxo;
  /** The ancestor delegations, parent first. */
  ancestors: ChainUtxo[];
  /** The records of every delegate, of the root agent delegator, and their ancestors. */
  records: ChainUtxo[];
}

/** Builders for the delegation contract, and delegation reads. */
export class Delegations {
  constructor(readonly ctx: IdentityContext) {}

  async get(delegationId: string): Promise<DelegationUtxo> {
    return this.ctx.delegation(delegationId);
  }

  /** Every live (authentic) delegation. */
  async list(): Promise<DelegationUtxo[]> {
    return this.ctx.delegations();
  }

  /** A record and its ancestors, as outputs. */
  private async recordWithAncestors(vectorId: string): Promise<ChainUtxo[]> {
    const record = await this.ctx.record(vectorId);
    const ancestors = await this.ctx.ancestors(record.datum);
    return [record.utxo, ...ancestors.map((a) => a.utxo)];
  }

  /** The delegation, its ancestors and every record that its use checks read. */
  async useInputs(delegationId: string): Promise<DelegationUseInputs> {
    const leaf = await this.ctx.delegation(delegationId);
    const ancestors: ChainUtxo[] = [];
    const records = new Map<string, ChainUtxo>();
    const addRecords = async (vectorId: string): Promise<void> => {
      for (const u of await this.recordWithAncestors(vectorId)) records.set(`${u.ref.txHash}#${u.ref.index}`, u);
    };
    let link = leaf;
    for (let depth = 0; depth < 4; depth += 1) {
      await addRecords(link.datum.delegate);
      if (link.datum.parent === null) {
        if (link.datum.delegator.type === 'Agent') await addRecords(link.datum.delegator.id);
        return { leaf, ancestors, records: [...records.values()] };
      }
      link = await this.ctx.delegation(link.datum.parent);
      ancestors.push(link.utxo);
    }
    return ruleError('delegation_too_deep', 'the delegation chain has more than 4 links');
  }

  /**
   * The §5.2 use checks of a dependent contract, off-chain: authentic
   * delegations, Active agents, delegate keys still listed, the action and
   * resource covered, the window inside the period. Returns the outputs to
   * reference.
   */
  async checkUse(delegationId: string, action: string, resource: string, window: ValidityWindow): Promise<{ leaf: DelegationUtxo; references: ChainUtxo[] }> {
    const inputs = await this.useInputs(delegationId);
    const scripts = this.ctx.scripts;
    return delegationUse({
      identityHash: scripts.identity.hash,
      delegationHash: scripts.delegation.hash,
      leaf: inputs.leaf.utxo,
      ancestors: inputs.ancestors,
      records: inputs.records,
      action,
      resource,
      window,
    });
  }

  /** Create a delegation. The new token name is `delegationId`. */
  async delegate(options: DelegateOptions): Promise<DelegateTx> {
    const delegate = toVectorId(options.delegate, 'delegate');
    const delegateKey = options.delegateKey.toLowerCase();
    const parent = options.parent === undefined ? undefined : await this.ctx.delegation(options.parent);
    let delegator = options.delegator;
    if (parent !== undefined) {
      if (delegator !== undefined && (delegator.type !== 'Agent' || delegator.id !== parent.datum.delegate)) {
        ruleError('delegator_with_parent', "a sub-delegation's delegator is the parent's delegate agent");
      }
      delegator = undefined;
    } else if (delegator === undefined) {
      ruleError('delegator_missing', 'a delegation without a parent needs its delegator');
    }
    const agents = new Set<string>([delegate]);
    if (parent !== undefined) agents.add(parent.datum.delegate);
    if (delegator?.type === 'Agent') agents.add(delegator.id);
    const [prepared, seed, live, ...recordLists] = await Promise.all([
      this.ctx.prepare(options),
      this.ctx.seedOf(options.fundingAddress, options.seed),
      this.ctx.delegations(),
      ...[...agents].map((id) => this.recordWithAncestors(id)),
    ]);
    const inUse = live.filter((d) => d.datum.delegateKey === delegateKey);
    if (inUse.length > 0) ruleError('delegate_key_in_use', `delegate_key is in use by the live delegation ${inUse[0]!.id}; use a fresh listed key`);
    const scripts = await this.ctx.delegationScripts();
    const args = {
      seed,
      window: prepared.window,
      ...(delegator === undefined ? {} : { delegator }),
      ...(options.delegatorKeyHash === undefined ? {} : { agentSigner: options.delegatorKeyHash }),
      ...(parent === undefined ? {} : { parent: parent.utxo }),
      delegate,
      delegateKey,
      actions: options.actions,
      resources: options.resources ?? [],
      notBefore: options.notBefore ?? prepared.window.lo,
      notAfter: options.notAfter,
      remaining: options.remaining ?? 0,
      purpose: options.purpose ?? null,
      value: options.value ?? null,
      records: recordLists.flat(),
      inUseDelegateKeys: live.map((d) => d.datum.delegateKey),
    };
    return this.ctx.complete(prepared.tx, (ctx) => buildDelegate(ctx, scripts, args), options.evaluate);
  }

  /**
   * Burn a delegation. Its delegator signs (`level` 0), or the delegator of
   * the ancestor `level` links up (the ancestors are reference inputs). For
   * an agent delegator, its controller signs, or `signerKeyHash` (a listed
   * key with the delegation purpose).
   */
  async undelegate(options: BuildOptions & { delegationId: string; level?: number; signerKeyHash?: string }): Promise<UnsignedTx> {
    const leaf = await this.ctx.delegation(options.delegationId);
    const ancestors: ChainUtxo[] = [];
    let link = leaf;
    for (let i = 0; i < (options.level ?? 0); i += 1) {
      if (link.datum.parent === null) ruleError('revoker_not_delegator', `the delegation has fewer than ${options.level} ancestors`);
      link = await this.ctx.delegation(link.datum.parent);
      ancestors.push(link.utxo);
    }
    const delegator = link.datum.delegator;
    const [prepared, scripts, records] = await Promise.all([
      this.ctx.prepare(options),
      this.ctx.delegationScripts(),
      delegator.type === 'Agent' ? this.ctx.record(delegator.id).then((r) => [r.utxo]) : Promise.resolve([]),
    ]);
    const revoker = delegator.type === 'PrincipalKey'
      ? { type: 'PrincipalKey' as const, hash: delegator.hash }
      : { type: 'Agent' as const, id: delegator.id, ...(options.signerKeyHash === undefined ? {} : { signer: options.signerKeyHash }) };
    return this.ctx.complete(prepared.tx, (ctx) => buildUndelegate(ctx, scripts, {
      delegation: leaf.utxo,
      window: prepared.window,
      revoker,
      ancestors,
      records,
    }), options.evaluate);
  }
}
