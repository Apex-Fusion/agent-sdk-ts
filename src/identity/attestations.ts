/**
 * Attestations (Part 2 §4): attest, revoke, contest and withdraw, over the
 * vendored builders, and the COSE_Sign1 envelope of §4.2.
 *
 * Envelope: `envelope_sig` is an Ed25519 signature over
 * `Sig_structure = ["Signature1", protected, h'', digest]` (RFC 9052 §4.4,
 * https://www.rfc-editor.org/rfc/rfc9052#section-4.4). The protected header
 * uses the core deterministic encoding of RFC 8949 §4.2.1
 * (https://www.rfc-editor.org/rfc/rfc8949#section-4.2.1):
 * `{1: -19 (EdDSA, RFC 9053), 4: kid, 15: {1: iss, 2: sub, 6: iat} (CWT
 * claims, RFC 9597), 258: -16 (SHA-256 payload hash), 259: format}`, with
 * 259 left out when `format` is None. The issuer DID is
 * `did:vector:<issuer_id>`, or the `did:key` of the issuer key (W3C did:key
 * v0.7, https://w3c-ccg.github.io/did-method-key/) when `issuer_id` is empty.
 */
import * as ed from '@noble/ed25519';
import type { ChainUtxo } from '../chain/identity-chain.js';
import type { BuildOptions, IdentityContext } from './context.js';
import { ruleError } from './errors.js';
import { toVectorId } from './ids.js';
import {
  activeKey,
  buildAttest,
  buildContest,
  buildRevokeAtt,
  buildWithdrawAttestation,
  bytesToHex,
  cborArray,
  cborBytes,
  cborInt,
  cborMap,
  concatBytes,
  hexToBytes,
  keyHash,
  PURPOSE_ASSERTION,
  vectorDid,
  type AttestationContent,
  type AttestationDatum,
  type AttestTx,
  type IssuerAuthority,
  type Link,
  type OutputReference,
  type UnsignedTx,
} from './vendor.js';
import type { AuthenticOutput } from './context.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btc(bytes: Uint8Array): string {
  let value = BigInt(`0x${bytesToHex(bytes) || '0'}`);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** `did:key` of an Ed25519 public key: `z` + base58btc(0xed 0x01 ‖ key) (W3C did:key v0.7). */
export function didKey(publicKey: string): string {
  return `did:key:z${base58btc(concatBytes([Uint8Array.of(0xed, 0x01), hexToBytes(publicKey)]))}`;
}

/** A CBOR text string (major type 3), definite length. */
function cborText(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const head = cborBytes(bytes);
  head[0] = (head[0]! & 0x1f) | 0x60;
  return head;
}

/** The issuer DID and the kid of §4.2. */
function issuerDid(datum: AttestationDatum): { did: string; kid: string } {
  if (datum.issuerId !== null) {
    const did = vectorDid(datum.issuerId);
    return { did, kid: `${did}#${keyHash(datum.issuer)}` };
  }
  const did = didKey(datum.issuer);
  return { did, kid: `${did}#${did.slice('did:key:'.length)}` };
}

/** The protected header of §4.2 in core deterministic encoding (keys 1, 4, 15, 258, 259). */
export function envelopeProtectedHeader(datum: AttestationDatum): Uint8Array {
  const { did, kid } = issuerDid(datum);
  const claims = cborMap([
    [cborInt(1), cborText(did)],
    [cborInt(2), cborText(vectorDid(datum.subject))],
    [cborInt(6), cborInt(Math.floor(datum.issuedAt / 1000))],
  ]);
  const entries: Array<readonly [Uint8Array, Uint8Array]> = [
    [cborInt(1), cborInt(-19)],
    [cborInt(4), cborBytes(new TextEncoder().encode(kid))],
    [cborInt(15), claims],
    [cborInt(258), cborInt(-16)],
  ];
  if (datum.format !== null) entries.push([cborInt(259), cborInt(datum.format)]);
  return cborMap(entries);
}

/** `Sig_structure = ["Signature1", protected, h'', digest]`: the bytes that the issuer key signs. */
export function envelopeSigStructure(datum: AttestationDatum): Uint8Array {
  return cborArray([cborText('Signature1'), cborBytes(envelopeProtectedHeader(datum)), cborBytes(new Uint8Array(0)), cborBytes(hexToBytes(datum.digest))]);
}

/** True when `envelope_sig` is a valid Ed25519 signature of the issuer key (false when absent). */
export async function verifyEnvelope(datum: AttestationDatum): Promise<boolean> {
  if (datum.envelopeSig === null) return false;
  try {
    return await ed.verifyAsync(hexToBytes(datum.envelopeSig), envelopeSigStructure(datum), hexToBytes(datum.issuer));
  } catch {
    return false;
  }
}

/** True when the issuer can withdraw: revoked with `at + 90 days ≤ lo`, or `valid_until + 90 days ≤ lo`. */
export function withdrawable(datum: AttestationDatum, lo: number): boolean {
  const days90 = 90 * 86_400_000;
  return (datum.status.type === 'AttRevoked' && datum.status.at + days90 <= lo)
    || (datum.validUntil !== null && datum.validUntil + days90 <= lo);
}

export interface AttestOptions extends BuildOptions {
  /** The subject agent: its identifier or DID. Its record (live or tombstone) is a reference input. */
  subject: string;
  /** The issuer's Ed25519 public key (32 bytes, hex). It signs. */
  issuer: string;
  /** 0 identity, 1 provenance, 2 software, 3 environment, 4 principal binding, 5 approval, 15 other. */
  attType: number;
  /** SHA-256 of the document (32 bytes, hex); a salted commitment for types 4 and 5. */
  digest: string;
  /** A registered issuer: the agent whose record lists the issuer key with the assertion purpose. */
  issuerId?: string;
  /** CoAP Content-Format of the document. */
  format?: number | null;
  /** 32 bytes (hex): hash of the profile or type URI. */
  profile?: string | null;
  /** A retrieval hint, UTF-8 text of up to 256 bytes. */
  locator?: string | null;
  validFrom?: number | null;
  /** At most 366 days after issued_at (= hi); required for types 2 and 3. */
  validUntil?: number | null;
  /** The subject's controller co-signs. */
  solicited?: boolean;
  links?: Link[];
  /**
   * Signs the `Sig_structure` of §4.2 with the issuer key and returns the
   * 64-byte Ed25519 signature (bytes or hex). The client checks it.
   */
  signEnvelope?: (sigStructure: Uint8Array) => Promise<Uint8Array | string> | Uint8Array | string;
  /** Default: the funding output with the lowest reference. The token name derives from it. */
  seed?: OutputReference;
  /** The attestation output's AP3X (default and minimum 5 AP3X). */
  deposit?: bigint;
}

export interface AttestationActionOptions extends BuildOptions {
  attestationId: string;
}

/** Builders for the attestation contract, and attestation reads. */
export class Attestations {
  constructor(readonly ctx: IdentityContext) {}

  async get(attestationId: string): Promise<AuthenticOutput<AttestationDatum>> {
    return this.ctx.attestation(attestationId);
  }

  /** Issue an attestation about `subject`. The new token name is `attestationId`. */
  async attest(options: AttestOptions): Promise<AttestTx> {
    const subjectId = toVectorId(options.subject, 'subject');
    const [prepared, seed, subject] = await Promise.all([
      this.ctx.prepare(options),
      this.ctx.seedOf(options.fundingAddress, options.seed),
      this.ctx.record(subjectId),
    ]);
    let issuerRecord: { record: ChainUtxo; ancestors: ChainUtxo[] } | undefined;
    let issuerId: string | null = null;
    if (options.issuerId !== undefined) {
      const record = await this.ctx.record(toVectorId(options.issuerId, 'issuerId'));
      const ancestors = await this.ctx.ancestors(record.datum);
      issuerRecord = { record: record.utxo, ancestors: ancestors.map((a) => a.utxo) };
      issuerId = record.id;
    }
    const { window } = prepared;
    const content: AttestationContent = {
      attType: options.attType,
      format: options.format ?? null,
      profile: options.profile ?? null,
      digest: options.digest,
      locator: options.locator === undefined || options.locator === null ? null : bytesToHex(new TextEncoder().encode(options.locator)),
      envelopeSig: null,
      validFrom: options.validFrom ?? null,
      validUntil: options.validUntil ?? null,
      solicited: options.solicited ?? false,
      links: options.links ?? [],
    };
    if (options.signEnvelope !== undefined) {
      const datum: AttestationDatum = {
        subject: subject.id,
        issuer: options.issuer,
        issuerId,
        ...content,
        issuedAt: window.hi,
        status: { type: 'AttActive' },
        contested: null,
      };
      const signature = await options.signEnvelope(envelopeSigStructure(datum));
      const envelopeSig = typeof signature === 'string' ? signature.toLowerCase() : bytesToHex(signature);
      if (!(await verifyEnvelope({ ...datum, envelopeSig }))) {
        ruleError('envelope_invalid', 'signEnvelope did not return a valid Ed25519 signature of the issuer key over the Sig_structure');
      }
      content.envelopeSig = envelopeSig;
    }
    const scripts = await this.ctx.attestationScripts();
    const args = {
      seed,
      window,
      subject: subject.utxo,
      issuer: options.issuer,
      content,
      ...(issuerRecord === undefined ? {} : { issuerRecord }),
      ...(options.deposit === undefined ? {} : { deposit: options.deposit }),
    };
    return this.ctx.complete(prepared.tx, (ctx) => buildAttest(ctx, scripts, args), options.evaluate);
  }

  /** The issuer record when the attestation names one, and the authority that acts. */
  private async issuer(datum: AttestationDatum, by: IssuerAuthority | undefined): Promise<{ issuerRecord?: ChainUtxo; authority?: IssuerAuthority }> {
    if (datum.issuerId === null) return by === undefined ? {} : { authority: by };
    const record = await this.ctx.record(datum.issuerId);
    const authority = by ?? (activeKey(record.datum, keyHash(datum.issuer), PURPOSE_ASSERTION) ? 'issuer' : 'controller');
    return { issuerRecord: record.utxo, authority };
  }

  /**
   * RevokeAtt: AttActive becomes AttRevoked { at: lo, reason }. `by`: the
   * issuer key (default while the issuer record still lists it) or the
   * issuer record's controller.
   */
  async revoke(options: AttestationActionOptions & { reason: number; by?: IssuerAuthority }): Promise<UnsignedTx> {
    const [attestation, prepared] = await Promise.all([this.ctx.attestation(options.attestationId), this.ctx.prepare(options)]);
    const [authority, scripts] = await Promise.all([this.issuer(attestation.datum, options.by), this.ctx.attestationScripts()]);
    return this.ctx.complete(prepared.tx, (ctx) => buildRevokeAtt(ctx, scripts, {
      attestation: attestation.utxo,
      window: prepared.window,
      reason: options.reason,
      ...authority,
    }), options.evaluate);
  }

  /** Contest: the subject's controller attaches its reply (UTF-8 `uri` of 1..256 bytes, `sha256` of 32 bytes hex). */
  async contest(options: AttestationActionOptions & { uri: string; sha256: string }): Promise<UnsignedTx> {
    const attestation = await this.ctx.attestation(options.attestationId);
    const [subject, prepared, scripts] = await Promise.all([
      this.ctx.record(attestation.datum.subject),
      this.ctx.prepare(options),
      this.ctx.attestationScripts(),
    ]);
    const anchor = { uri: bytesToHex(new TextEncoder().encode(options.uri)), sha256: options.sha256.toLowerCase() };
    return this.ctx.complete(prepared.tx, (ctx) => buildContest(ctx, scripts, {
      attestation: attestation.utxo,
      window: prepared.window,
      subject: subject.utxo,
      anchor,
    }), options.evaluate);
  }

  /** Withdraw with Burn: 90 days after the revocation or after valid_until; the issuer takes the deposit. */
  async withdraw(options: AttestationActionOptions & { by?: IssuerAuthority }): Promise<UnsignedTx> {
    const [attestation, prepared] = await Promise.all([this.ctx.attestation(options.attestationId), this.ctx.prepare(options)]);
    const [authority, scripts] = await Promise.all([this.issuer(attestation.datum, options.by), this.ctx.attestationScripts()]);
    return this.ctx.complete(prepared.tx, (ctx) => buildWithdrawAttestation(ctx, scripts, {
      attestation: attestation.utxo,
      window: prepared.window,
      ...authority,
    }), options.evaluate);
  }
}
