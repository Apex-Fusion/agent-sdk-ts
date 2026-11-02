/**
 * DID resolution through the identity gateway's HTTPS binding (did:vector
 * Part 1 §7.4): `GET {gateway}/1.0/identifiers/{did}` as defined by DID
 * Resolution v1.0 (https://www.w3.org/TR/did-resolution/). Options are query
 * parameters. The resolver percent-decodes the path once.
 *
 * HTTP statuses (Part 1 §7.4): 200 found, 410 deactivated, 400 INVALID_DID or
 * INVALID_OPTIONS, 404 NOT_FOUND, 406 REPRESENTATION_NOT_SUPPORTED, 501
 * METHOD_NOT_SUPPORTED or FEATURE_NOT_SUPPORTED, 500 INTERNAL_ERROR. Every
 * error carries a resolution result.
 */
import crossFetch from 'cross-fetch';
import { z } from 'zod';
import { DEFAULT_IDENTITY_GATEWAY_URL } from '../constants.js';
import { ConnectionError, VectorError } from '../errors.js';
import { isVectorId, parseVectorDid, vectorDid } from './vendor.js';

export const RESOLUTION_MEDIA_TYPE = 'application/did-resolution';
export const DOCUMENT_MEDIA_TYPE = 'application/did';
const MAX_BODY_BYTES = 1 << 20;

/** The resolver answered with a DID Resolution error, for example NOT_FOUND. */
export class DidResolutionError extends VectorError {
  constructor(readonly error: string, readonly title: string, readonly status: number) {
    super(`${error}: ${title} (HTTP ${status})`);
    this.name = 'DidResolutionError';
  }
}

const objectRecord = z.record(z.string(), z.unknown());
const errorMetadata = z.object({ type: z.string(), title: z.string().optional() }).passthrough();

/** One answer of the HTTPS binding: the HTTP status, the JSON body and its media type. */
export class DidResolution {
  constructor(readonly status: number, readonly body: Readonly<Record<string, unknown>>, readonly contentType: string = RESOLUTION_MEDIA_TYPE) {}

  /** True when the body is a DID document only (`Accept: application/did`). */
  get isDocument(): boolean {
    const mediaType = this.contentType.split(';', 1)[0]!.trim().toLowerCase();
    return mediaType === DOCUMENT_MEDIA_TYPE && !('didResolutionMetadata' in this.body);
  }

  get document(): Record<string, unknown> | null {
    if (this.isDocument) return { ...this.body };
    const parsed = objectRecord.safeParse(this.body.didDocument);
    return parsed.success ? parsed.data : null;
  }

  get metadata(): Record<string, unknown> {
    if (this.isDocument) return {};
    const parsed = objectRecord.safeParse(this.body.didDocumentMetadata);
    return parsed.success ? parsed.data : {};
  }

  get resolutionMetadata(): Record<string, unknown> {
    if (this.isDocument) return {};
    const parsed = objectRecord.safeParse(this.body.didResolutionMetadata);
    return parsed.success ? parsed.data : {};
  }

  /** The error name, for example `NOT_FOUND`; null for a found DID. */
  get error(): string | null {
    const parsed = errorMetadata.safeParse(this.resolutionMetadata.error);
    if (!parsed.success) return null;
    return parsed.data.type.split('#').pop() || 'UNKNOWN_ERROR';
  }

  get deactivated(): boolean {
    return this.metadata.deactivated === true;
  }

  /** Throws `DidResolutionError` for a DID Resolution error; returns this result otherwise. */
  raiseForError(): this {
    const error = this.error;
    if (error !== null) {
      const parsed = errorMetadata.safeParse(this.resolutionMetadata.error);
      throw new DidResolutionError(error, parsed.success ? parsed.data.title ?? '' : '', this.status);
    }
    return this;
  }
}

/** A listed key of the resolved view: its `vectorKeys` entry and the public key of the document. */
export interface ResolvedKey {
  keyHash: string;
  /** `Ed25519` or `P-256`. */
  type: string;
  /** `authentication`, `assertion`, `transaction`, `delegation`, as they apply. */
  purposes: string[];
  publicKeyMultibase: string | null;
}

const resolvedMetadata = z.object({
  canonicalId: z.string().optional(),
  versionId: z.string().optional(),
  vectorOrigin: z.string().optional(),
  vectorStatus: z.object({
    status: z.string().optional(),
    effective: z.string().optional(),
    effectiveReason: z.string().optional(),
  }).passthrough().optional(),
  vectorKeys: z.array(z.object({ id: z.string(), type: z.string(), purposes: z.array(z.string()).optional() }).passthrough()).optional(),
  vectorParties: z.array(objectRecord).optional(),
  vectorProfile: objectRecord.optional(),
  vectorParent: objectRecord.optional(),
  vectorRecovery: objectRecord.optional(),
  vectorLedger: z.object({ txId: z.string(), outputIndex: z.number().int().optional() }).passthrough().optional(),
  vectorPending: z.array(z.string()).optional(),
}).passthrough();

const verificationMethods = z.array(z.object({ id: z.string(), publicKeyMultibase: z.string().optional() }).passthrough());

/** The current record of an agent as the resolver shows it without options (Part 1 §7.2–§7.3, §8.2). */
export class AgentView {
  readonly vectorId: string;
  /** Effective status: `active`, `suspended`, `revoked` or `retired`. */
  readonly effective: string;
  readonly effectiveReason: string | null;
  /** Status of the view (before the effective-status rules). */
  readonly status: string;
  readonly deactivated: boolean;
  /** `native`, `adopted` or `legacy`. */
  readonly origin: string | null;
  readonly versionId: string | null;
  readonly controllerKeyHash: string | null;
  readonly keys: ResolvedKey[];
  readonly parties: Array<Record<string, unknown>>;
  readonly profile: Record<string, unknown>;
  readonly parent: Record<string, unknown> | null;
  readonly recovery: Record<string, unknown> | null;
  readonly ledger: { txId: string; outputIndex?: number; [key: string]: unknown } | null;
  readonly pending: string[];

  constructor(readonly did: string, readonly resolution: DidResolution) {
    const parsed = resolvedMetadata.safeParse(resolution.metadata);
    if (!parsed.success) throw new ConnectionError(`the identity gateway sent metadata of an unknown shape: ${parsed.error.message}`);
    const m = parsed.data;
    const document = resolution.document ?? {};
    const methods = verificationMethods.safeParse(document.verificationMethod);
    const byHash = new Map((methods.success ? methods.data : []).map((v) => [v.id.split('#').pop() ?? '', v.publicKeyMultibase ?? null]));
    const invocation = z.array(z.string()).safeParse(document.capabilityInvocation);
    const canonical = parseVectorDid(m.canonicalId ?? did) ?? parseVectorDid(did);
    this.vectorId = canonical?.vectorId ?? '';
    this.effective = m.vectorStatus?.effective ?? '';
    this.effectiveReason = m.vectorStatus?.effectiveReason ?? null;
    this.status = m.vectorStatus?.status ?? '';
    this.deactivated = resolution.deactivated;
    this.origin = m.vectorOrigin ?? null;
    this.versionId = m.versionId ?? null;
    this.controllerKeyHash = invocation.success && invocation.data.length > 0 ? invocation.data[0]!.split('#').pop() ?? null : null;
    this.keys = (m.vectorKeys ?? []).map((k) => {
      const keyHash = k.id.split('#').pop() ?? '';
      return { keyHash, type: k.type, purposes: k.purposes ?? [], publicKeyMultibase: byHash.get(keyHash) ?? null };
    });
    this.parties = m.vectorParties ?? [];
    this.profile = m.vectorProfile ?? {};
    this.parent = m.vectorParent ?? null;
    this.recovery = m.vectorRecovery ?? null;
    this.ledger = m.vectorLedger ?? null;
    this.pending = m.vectorPending ?? [];
  }

  /** `<tx id>#<index>` of the record output that the base version owns, or null. */
  get recordOutput(): string | null {
    return this.ledger?.outputIndex === undefined ? null : `${this.ledger.txId}#${this.ledger.outputIndex}`;
  }

  /** True when the view lists the key with this purpose (`authentication`, `assertion`, `transaction` or `delegation`). */
  hasKey(keyHash: string, purpose: string): boolean {
    return this.keys.some((k) => k.keyHash === keyHash && k.purposes.includes(purpose));
  }
}

export interface ResolveOptions {
  /** A version number (`0` or a decimal without leading zeros). */
  versionId?: string | number;
  /** `YYYY-MM-DDThh:mm:ssZ` (UTC, no fractions); a `Date` is written in that form, rounded down to the second. */
  versionTime?: string | Date;
  expandRelativeUrls?: boolean;
  /** Ask for the DID document only (`Accept: application/did`). */
  documentOnly?: boolean;
}

export interface IdentityGatewayOptions {
  /** Default 15 000 ms. */
  timeoutMs?: number;
  /** A fetch implementation (default: cross-fetch). */
  fetch?: typeof crossFetch;
}

/** `YYYY-MM-DDThh:mm:ssZ` of a date, rounded down to the second. */
export function formatVersionTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Client of the identity gateway (default `https://id.vector.apexfusion.org`). */
export class IdentityGateway {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof crossFetch;

  constructor(baseUrl: string = DEFAULT_IDENTITY_GATEWAY_URL, options: IdentityGatewayOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? crossFetch;
  }

  /**
   * Resolves a DID. DID errors come back as a result; read `error`, or call
   * `raiseForError()`. Throws `ConnectionError` when the gateway cannot be
   * reached or does not answer with a resolution result.
   */
  async resolve(did: string, options: ResolveOptions = {}): Promise<DidResolution> {
    const query = new URLSearchParams();
    if (options.versionId !== undefined) query.set('versionId', String(options.versionId));
    if (options.versionTime !== undefined) {
      query.set('versionTime', options.versionTime instanceof Date ? formatVersionTime(options.versionTime) : options.versionTime);
    }
    if (options.expandRelativeUrls !== undefined) query.set('expandRelativeUrls', options.expandRelativeUrls ? 'true' : 'false');
    const path = encodeURIComponent(did).replace(/%3A/gi, ':');
    const queryText = query.toString();
    const url = `${this.baseUrl}/1.0/identifiers/${path}${queryText === '' ? '' : `?${queryText}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let contentType: string;
    let text: string;
    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: options.documentOnly ? DOCUMENT_MEDIA_TYPE : RESOLUTION_MEDIA_TYPE },
        redirect: 'error',
        signal: controller.signal,
      });
      status = response.status;
      contentType = response.headers.get('content-type') ?? RESOLUTION_MEDIA_TYPE;
      text = await response.text();
    } catch (err) {
      throw new ConnectionError(`identity gateway request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new ConnectionError('identity gateway answer is larger than 1 MiB');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ConnectionError(`identity gateway answered HTTP ${status} without JSON`);
    }
    const body = objectRecord.safeParse(json);
    if (!body.success) throw new ConnectionError('identity gateway answer is not a JSON object');
    const resolution = new DidResolution(status, body.data, contentType);
    if (!resolution.isDocument && !('didResolutionMetadata' in body.data)) {
      throw new ConnectionError(`identity gateway answered HTTP ${status} without a resolution result`);
    }
    return resolution;
  }

  /**
   * The resolver's view of an agent (a vector-id or a DID) without version
   * options. Throws `DidResolutionError` for a DID error. A deactivated DID
   * (HTTP 410) is not an error: the view has `deactivated` set.
   */
  async currentRecord(agent: string): Promise<AgentView> {
    const did = isVectorId(agent) ? vectorDid(agent) : agent;
    const resolution = (await this.resolve(did)).raiseForError();
    return new AgentView(did, resolution);
  }
}
