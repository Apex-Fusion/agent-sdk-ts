/**
 * IdentityContext: the configuration, the applied scripts, the slot clock
 * and the chain reads that every identity client shares, and the step that
 * turns a builder call into an unsigned transaction with measured execution
 * units.
 *
 * Every read goes to the chain when a transaction is built: the protocol
 * parameters (with the Plutus V3 cost model, which feeds the script data
 * hash), the wallet outputs, the tip and, for a Module-1 consent, the reward
 * balance of Module-1. Only the slot clock, the derived scripts and the
 * configuration record are cached; the configuration record never changes
 * (Part 2 §3.8).
 */
import type { ProtocolParameters as LucidProtocolParameters } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '../chain/ogmios-provider.js';
import type { ChainUtxo, IdentityChain } from '../chain/identity-chain.js';
import { TransactionError } from '../errors.js';
import { IDENTITY_ENV_VARS, identityConfig, type IdentityConfig, type IdentityConfigInput } from './config.js';
import { IdentityConfigError, IdentityLookupError } from './errors.js';
import { IdentityGateway } from './gateway.js';
import { deriveIdentityDeployment, type IdentityDeployment } from './scripts.js';
import {
  CONFIG_TOKEN_NAME,
  compareOutRefs,
  decodeAttestationDatum,
  isEnterpriseAddressOf,
  plutusV3Hash,
  readConfigRecord,
  readDelegation,
  readRecord,
  utxoAssets,
  validityWindow,
  type AdoptionScripts,
  type AttestationDatum,
  type AttestationScripts,
  type DelegationScripts,
  type DelegationUtxo,
  type ExUnits,
  type IdentityDatum,
  type IdentityScripts,
  type NetworkId,
  type OutputReference,
  type ProtocolParameters,
  type RecordUtxo,
  type ScriptSource,
  type SlotConfig,
  type TxContext,
  type UnsignedTx,
  type ValidityWindow,
  type VaultScripts,
} from './vendor.js';

/** Default seconds between the tip and the end of the validity range. */
export const DEFAULT_VALID_FOR_SECONDS = 900;
/** The validity range starts this many milliseconds before the tip. */
export const WINDOW_BACKPAD_MS = 60_000;
/** Measured execution units get this margin, in percent. */
const UNITS_MARGIN_PERCENT = 3n;
const MAX_VALID_FOR_SECONDS = (3_600_000 - WINDOW_BACKPAD_MS) / 1000;

/** Options that every transaction builder of the clients takes. */
export interface BuildOptions {
  /** The address that pays the fee and any deposit; its outputs fund the transaction. */
  fundingAddress: string;
  /** Where the change goes (default: the funding address). */
  changeAddress?: string;
  /** Seconds between the tip and the end of the validity range (default 900; the range stays within one hour). */
  validForSeconds?: number;
  /**
   * Evaluate the redeemers with the chain (Ogmios `evaluateTransaction`) and
   * build again with the measured units (default true). Without it, each
   * redeemer gets an equal share of the transaction limit: the transaction
   * is valid, but its fee is about 2 AP3X.
   */
  evaluate?: boolean;
  /** AP3X-only key-locked outputs for collateral (default: the funding outputs). */
  collateral?: ChainUtxo[];
}

/** An authentic output with its token name and decoded datum. */
export interface AuthenticOutput<D> {
  utxo: ChainUtxo;
  id: string;
  datum: D;
}

/** The builder's protocol parameters from the chain's (lucid's) protocol parameters. */
export function builderProtocolParameters(pp: LucidProtocolParameters): ProtocolParameters {
  // Lucid types the cost model as a record; Ogmios v6 gives a list in ledger order. Both pass here.
  const raw: unknown = pp.costModels?.PlutusV3;
  const list: unknown[] | null = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' ? Object.values(raw) : null;
  if (list === null || list.length === 0 || !list.every((n): n is number => typeof n === 'number' && Number.isInteger(n))) {
    throw new IdentityConfigError('the chain gave no Plutus V3 cost model; the script data hash needs the cost model of the chain');
  }
  return {
    minFeeA: pp.minFeeA,
    minFeeB: pp.minFeeB,
    priceMem: pp.priceMem,
    priceStep: pp.priceStep,
    coinsPerUtxoByte: pp.coinsPerUtxoByte,
    collateralPercentage: pp.collateralPercentage,
    maxCollateralInputs: pp.maxCollateralInputs,
    maxTxSize: pp.maxTxSize,
    maxTxExMem: pp.maxTxExMem,
    maxTxExSteps: pp.maxTxExSteps,
    minFeeRefScriptCostPerByte: pp.minFeeRefScriptCostPerByte,
    costModels: { PlutusV3: list },
  };
}

const refKey = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

/** The token names of `policy` in an output: authentic outputs hold exactly one, with quantity 1. */
function soleToken(utxo: ChainUtxo, policy: string): string | null {
  const tokens = utxoAssets(utxo).filter((a) => a.policy === policy);
  return tokens.length === 1 && tokens[0]!.quantity === 1n ? tokens[0]!.name : null;
}

export interface IdentityContextOptions {
  /** The chain reads (default: an `OgmiosProvider` on the configured endpoints). */
  chain?: IdentityChain;
  /** Default: `identityConfig()`, from the environment. */
  config?: IdentityConfig;
  gateway?: IdentityGateway;
  /** 1 (default): Vector mainnet. The Vector testnet uses the mainnet network ID too. */
  networkId?: NetworkId;
  /** Default: read from the chain once. */
  slotConfig?: SlotConfig;
}

export class IdentityContext {
  readonly chain: IdentityChain;
  readonly config: IdentityConfig;
  readonly networkId: NetworkId;
  private gatewayClient: IdentityGateway | undefined;
  private slots: SlotConfig | undefined;
  private deployment: IdentityDeployment | undefined;
  private configRecordCache: { utxo: ChainUtxo; module1: string } | undefined;

  constructor(options: IdentityContextOptions = {}) {
    this.config = options.config ?? identityConfig();
    this.chain = options.chain ?? new OgmiosProvider({
      ogmiosUrl: this.config.ogmiosUrl,
      submitUrl: this.config.submitUrl,
      koiosUrl: this.config.koiosUrl,
      ...(this.config.koiosToken === null ? {} : { koiosToken: this.config.koiosToken }),
    });
    this.networkId = options.networkId ?? 1;
    this.gatewayClient = options.gateway;
    this.slots = options.slotConfig;
  }

  /** A context on the configured Ogmios and Koios endpoints; `overrides` win over the environment. */
  static fromEnv(overrides: IdentityConfigInput = {}): IdentityContext {
    return new IdentityContext({ config: identityConfig(overrides) });
  }

  /** The applied scripts. Throws `IdentityConfigError` when a deployment value is missing or wrong. */
  get scripts(): IdentityDeployment {
    if (this.deployment !== undefined) return this.deployment;
    const { legacyRoot, configSeed, legacyHash, identityPolicyId } = this.config;
    const missing = [
      ...(legacyRoot === null ? [IDENTITY_ENV_VARS.legacyRoot] : []),
      ...(configSeed === null ? [IDENTITY_ENV_VARS.configSeed] : []),
    ];
    if (legacyRoot === null || configSeed === null) {
      throw new IdentityConfigError(`missing deployment values: ${missing.join(', ')} (set the environment variables or pass them to identityConfig)`);
    }
    const deployment = deriveIdentityDeployment({ legacyRoot, configSeed, legacyHash, networkId: this.networkId });
    if (identityPolicyId !== null && identityPolicyId !== deployment.identity.hash) {
      throw new IdentityConfigError(
        `${IDENTITY_ENV_VARS.identityPolicyId} is ${identityPolicyId}, but ${IDENTITY_ENV_VARS.legacyRoot}, ${IDENTITY_ENV_VARS.configSeed} `
        + `and ${IDENTITY_ENV_VARS.legacyHash} give ${deployment.identity.hash}`,
      );
    }
    this.deployment = deployment;
    return deployment;
  }

  get gateway(): IdentityGateway {
    this.gatewayClient ??= new IdentityGateway(this.config.gatewayUrl);
    return this.gatewayClient;
  }

  async slotConfig(): Promise<SlotConfig> {
    this.slots ??= await this.chain.getSlotConfig();
    return this.slots;
  }

  /** The protocol parameters of the chain, in the builders' shape. Read on every call. */
  async protocolParameters(): Promise<ProtocolParameters> {
    return builderProtocolParameters(await this.chain.getProtocolParameters());
  }

  /** `[tip − 60 s, tip + validForSeconds]`, both at slot starts; the range stays within one hour. */
  async window(validForSeconds: number = DEFAULT_VALID_FOR_SECONDS): Promise<ValidityWindow> {
    if (!Number.isInteger(validForSeconds) || validForSeconds <= 0 || validForSeconds > MAX_VALID_FOR_SECONDS) {
      throw new IdentityConfigError(`validForSeconds must be 1..${MAX_VALID_FOR_SECONDS} (the range is at most one hour)`);
    }
    const [slots, tip] = await Promise.all([this.slotConfig(), this.chain.getTipSlot()]);
    const nowMs = slots.zeroTimeMs + (tip - slots.zeroSlot) * slots.slotLengthMs;
    return validityWindow(nowMs, slots, { pastMs: WINDOW_BACKPAD_MS, futureMs: validForSeconds * 1000 });
  }

  /**
   * The validity window and the builder context of one transaction: the
   * protocol parameters, the slot clock and the funding outputs, read now.
   */
  async prepare(options: BuildOptions): Promise<{ window: ValidityWindow; tx: TxContext }> {
    const [window, protocol, slotConfig, wallet] = await Promise.all([
      this.window(options.validForSeconds),
      this.protocolParameters(),
      this.slotConfig(),
      this.chain.queryUtxosAt(options.fundingAddress),
    ]);
    const tx: TxContext = {
      networkId: this.networkId,
      slotConfig,
      protocol,
      wallet,
      changeAddress: options.changeAddress ?? options.fundingAddress,
      ...(options.collateral === undefined ? {} : { collateral: options.collateral }),
    };
    return { window, tx };
  }

  /**
   * Builds with the builder, then (unless `evaluate` is false) evaluates the
   * redeemers on the chain and builds again with the measured units plus a
   * 3 % margin. When the second build spends other wallet outputs, the
   * result is evaluated again.
   */
  async complete<T extends UnsignedTx>(base: TxContext, build: (ctx: TxContext) => T, evaluate = true): Promise<T> {
    let tx = build(base);
    if (!evaluate || tx.redeemers.length === 0) return tx;
    for (let round = 0; round < 4; round += 1) {
      const measured = await this.chain.evaluateRedeemers(tx.txCborHex);
      const exUnits: Record<string, ExUnits> = {};
      for (const r of tx.redeemers) {
        const key = `${r.tag}:${r.index}`;
        const units = measured[key];
        if (units === undefined) throw new TransactionError(`the evaluation reported no units for redeemer ${key} (${r.label})`);
        exUnits[key] = {
          mem: units.mem + (units.mem * UNITS_MARGIN_PERCENT + 99n) / 100n,
          steps: units.steps + (units.steps * UNITS_MARGIN_PERCENT + 99n) / 100n,
        };
      }
      const next = build({ ...base, exUnits });
      const sameShape = next.inputs.map(refKey).join() === tx.inputs.map(refKey).join()
        && next.redeemers.map((r) => `${r.tag}:${r.index}`).join() === tx.redeemers.map((r) => `${r.tag}:${r.index}`).join();
      if (sameShape) return next;
      tx = next;
    }
    throw new TransactionError('the execution units did not settle: the coin selection changed in every round');
  }

  /** Submits a signed transaction through the chain and returns its ID. */
  async submit(signedTxCborHex: string): Promise<string> {
    return this.chain.submitTx(signedTxCborHex);
  }

  // ─── Authentic outputs ──────────────────────────────────────────────

  /** The outputs at exactly the script's enterprise address that hold exactly one token `name` of `policy`. */
  private async authentic(policy: string, name: string): Promise<ChainUtxo[]> {
    if (!/^[0-9a-f]{64}$/.test(name)) throw new IdentityLookupError(`${name} is not a 32-byte identifier (64 lowercase hex characters)`);
    const candidates = await this.chain.queryTokenUtxos(policy, name);
    return candidates.filter((u) => isEnterpriseAddressOf(u.address, { type: 'Script', hash: policy }) && soleToken(u, policy) === name);
  }

  private async single<T>(policy: string, id: string, read: (utxo: ChainUtxo) => T, what: string): Promise<T | null> {
    const found = await this.authentic(policy, id);
    if (found.length > 1) throw new IdentityLookupError(`${what} ${id}: more than one authentic output`);
    return found.length === 0 ? null : read(found[0]!);
  }

  /** The record of `vectorId` (live record or tombstone), or null. */
  async findRecord(vectorId: string): Promise<RecordUtxo | null> {
    const hash = this.scripts.identity.hash;
    return this.single(hash, vectorId, (u) => readRecord(u, hash), 'identity record');
  }

  async record(vectorId: string): Promise<RecordUtxo> {
    const found = await this.findRecord(vectorId);
    if (found === null) throw new IdentityLookupError(`no identity record for ${vectorId}`);
    return found;
  }

  /** The records of the parent, the grandparent and so on (at most 4), parent first. */
  async ancestors(record: IdentityDatum): Promise<RecordUtxo[]> {
    const chain: RecordUtxo[] = [];
    let current = record;
    while (current.lineage.type === 'Subagent' && chain.length < 4) {
      const parent = await this.record(current.lineage.parent);
      chain.push(parent);
      current = parent.datum;
    }
    return chain;
  }

  async findAttestation(attestationId: string): Promise<AuthenticOutput<AttestationDatum> | null> {
    const hash = this.scripts.attestation.hash;
    return this.single(hash, attestationId, (utxo) => {
      if (utxo.datumHex === null) throw new IdentityLookupError(`attestation ${attestationId} has no inline datum`);
      return { utxo, id: attestationId, datum: decodeAttestationDatum(utxo.datumHex) };
    }, 'attestation');
  }

  async attestation(attestationId: string): Promise<AuthenticOutput<AttestationDatum>> {
    const found = await this.findAttestation(attestationId);
    if (found === null) throw new IdentityLookupError(`no attestation ${attestationId}`);
    return found;
  }

  async findDelegation(delegationId: string): Promise<DelegationUtxo | null> {
    const hash = this.scripts.delegation.hash;
    return this.single(hash, delegationId, (u) => readDelegation(hash, u), 'delegation');
  }

  async delegation(delegationId: string): Promise<DelegationUtxo> {
    const found = await this.findDelegation(delegationId);
    if (found === null) throw new IdentityLookupError(`no delegation ${delegationId}`);
    return found;
  }

  /** Every authentic delegation output (the live delegations). */
  async delegations(): Promise<DelegationUtxo[]> {
    const { hash, address } = this.scripts.delegation;
    const out: DelegationUtxo[] = [];
    for (const utxo of await this.chain.queryUtxosAt(address)) {
      if (soleToken(utxo, hash) === null || utxo.datumHex === null) continue;
      try {
        out.push(readDelegation(hash, utxo));
      } catch {
        // Not a delegation that the contract wrote; readers ignore it.
      }
    }
    return out;
  }

  // ─── Configuration record and scripts ───────────────────────────────

  /** The configuration record (Part 2 §3.8) and M1, or null before the seal. */
  async configRecord(): Promise<{ utxo: ChainUtxo; module1: string } | null> {
    if (this.configRecordCache !== undefined) return this.configRecordCache;
    const { configSeal, configHolder } = this.scripts;
    const configured = this.config.configUtxo;
    const candidates = configured === null
      ? await this.chain.queryUtxosAt(configHolder.address)
      : await this.chain.queryUtxosByRefs([configured]);
    for (const utxo of candidates) {
      if (utxoAssets(utxo).find((a) => a.policy === configSeal.hash && a.name === CONFIG_TOKEN_NAME)?.quantity !== 1n) continue;
      try {
        this.configRecordCache = { utxo, module1: readConfigRecord(utxo, configSeal.hash, configHolder.hash) };
        return this.configRecordCache;
      } catch {
        // Not the configuration record.
      }
    }
    if (configured !== null) {
      throw new IdentityConfigError(`${IDENTITY_ENV_VARS.configUtxo} does not hold the configuration record of this deployment`);
    }
    return null;
  }

  /** M1: the Module-1 hash of the configuration record, or null before the seal. */
  async module1(): Promise<string | null> {
    return (await this.configRecord())?.module1 ?? null;
  }

  /** The reference-script output `ref`; it must hold the script `hash`. */
  private async referenceScript(ref: OutputReference, hash: string, variable: string): Promise<ScriptSource> {
    const [utxo] = await this.chain.queryUtxosByRefs([ref]);
    if (utxo === undefined) throw new IdentityConfigError(`${variable}: ${refKey(ref)} is spent or unknown`);
    if (utxo.scriptRef === null || plutusV3Hash(utxo.scriptRef) !== hash) {
      throw new IdentityConfigError(`${variable}: ${refKey(ref)} does not hold the script ${hash}`);
    }
    return { hash, referenceUtxo: utxo };
  }

  /** A deployment script from its configured reference output, else the script itself. */
  async scriptSource(name: 'identity' | 'attestation' | 'delegation' | 'vault' | 'legacy'): Promise<ScriptSource> {
    const scripts = this.scripts;
    const field = `${name}Ref` as const;
    const ref = this.config[field];
    if (name === 'legacy') {
      if (ref !== null) return this.referenceScript(ref, scripts.legacyHash, IDENTITY_ENV_VARS.legacyRef);
      if (scripts.legacy === null) {
        throw new IdentityConfigError(`the legacy registry code is unknown for ${scripts.legacyHash}; set ${IDENTITY_ENV_VARS.legacyRef}`);
      }
      return { hash: scripts.legacy.hash, compiledCode: scripts.legacy.compiledCode };
    }
    const script = scripts[name];
    if (ref !== null) return this.referenceScript(ref, script.hash, IDENTITY_ENV_VARS[field]);
    return { hash: script.hash, compiledCode: script.compiledCode };
  }

  /** Module-1 `identity_party` from `VECTOR_MODULE1_REF_UTXO`; it must hold M1. */
  async module1Source(): Promise<ScriptSource> {
    const m1 = await this.module1();
    if (m1 === null) throw new IdentityLookupError('the configuration record is not sealed: Module-1 cannot be a party');
    if (this.config.module1Ref === null) {
      throw new IdentityConfigError(`${IDENTITY_ENV_VARS.module1Ref} is required for a transaction that Module-1 approves`);
    }
    return this.referenceScript(this.config.module1Ref, m1, IDENTITY_ENV_VARS.module1Ref);
  }

  /** The whole reward balance of Module-1, read now: a consent must withdraw exactly this amount. */
  async module1RewardBalance(): Promise<Record<string, bigint>> {
    const m1 = await this.module1();
    if (m1 === null) throw new IdentityLookupError('the configuration record is not sealed: Module-1 cannot be a party');
    const balance = await this.chain.getRewardBalance(m1);
    if (balance === null) throw new IdentityLookupError(`the stake credential of Module-1 (${m1}) is not registered: it cannot approve`);
    return { [m1]: balance };
  }

  /** The identity scripts of the builders. `withModule1` adds the Module-1 script for a consent. */
  async identityScripts(withModule1 = false): Promise<IdentityScripts> {
    const scripts = this.scripts;
    const [identity, config, module1] = await Promise.all([
      this.scriptSource('identity'),
      this.configRecord(),
      withModule1 ? this.module1Source() : Promise.resolve(undefined),
    ]);
    return {
      identity,
      configPolicy: scripts.configSeal.hash,
      configHolder: scripts.configHolder.hash,
      ...(config === null ? {} : { configRecord: config.utxo }),
      ...(module1 === undefined ? {} : { module1 }),
    };
  }

  async adoptionScripts(withModule1 = false): Promise<AdoptionScripts> {
    const [identity, legacy] = await Promise.all([this.identityScripts(withModule1), this.scriptSource('legacy')]);
    return { ...identity, legacy, legacyRoot: this.scripts.legacyRoot };
  }

  async attestationScripts(): Promise<AttestationScripts> {
    return { attestation: await this.scriptSource('attestation'), identityHash: this.scripts.identity.hash };
  }

  async delegationScripts(): Promise<DelegationScripts> {
    return { delegation: await this.scriptSource('delegation'), identityHash: this.scripts.identity.hash };
  }

  async vaultScripts(): Promise<VaultScripts> {
    const scripts = this.scripts;
    return {
      vault: await this.scriptSource('vault'),
      identityHash: scripts.identity.hash,
      delegationHash: scripts.delegation.hash,
      escrowHash: scripts.escrow.hash,
    };
  }

  /** One output by reference, or `IdentityLookupError`. */
  async utxo(ref: OutputReference, what = 'output'): Promise<ChainUtxo> {
    const [found] = await this.chain.queryUtxosByRefs([ref]);
    if (found === undefined) throw new IdentityLookupError(`${what} ${refKey(ref)} is spent or unknown`);
    return found;
  }

  /** The seed of a new token: the funding output with the lowest reference. */
  async seedOf(fundingAddress: string, seed?: OutputReference): Promise<ChainUtxo> {
    if (seed !== undefined) return this.utxo(seed, 'the seed');
    const outputs = await this.chain.queryUtxosAt(fundingAddress);
    if (outputs.length === 0) throw new IdentityLookupError('the funding address has no output to use as a seed');
    return [...outputs].sort((a, b) => compareOutRefs(a.ref, b.ref))[0]!;
  }
}
