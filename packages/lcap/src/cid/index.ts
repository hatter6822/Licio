// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CID construction (OFFLINE_SPEC §9.2-§9.4): one binary layout and one string
// form for every CID kind, so a single verified routine produces and checks all
// of them.
//
//   cid_bytes   = 0x01 (cid_format_version) || kind_code || 0x12 (sha2-256)
//                 || 0x20 (digest length 32) || sha256(bytes)
//   cid_string  = human_prefix || base32(cid_bytes)
//
// The `kind_code` is bound into the hashed CID bytes (not just the human
// prefix), so a record digest can never be reinterpreted as a block digest.
// The CID input MUST be only the deterministic body — never proof, framing, or
// compression bytes (§9.2): `record_cid` excludes proof bytes by construction.

import { compareBytes } from '../cbor/encode.js';
import { getSubtle, toBufferSource } from '../runtime.js';
import { Base32Error, base32Decode, base32Encode } from './base32.js';

export { Base32Error, base32Decode, base32Encode } from './base32.js';

/** The four content-addressed object kinds (§9.2/§9.4). */
export type CidKind = 'record' | 'proof' | 'block' | 'chunk';

const CID_FORMAT_VERSION = 0x01;
const MULTIHASH_SHA2_256 = 0x12;
const SHA256_DIGEST_LEN = 0x20;
/** Total CID byte length: version + kind + 2 multihash bytes + 32-byte digest. */
const CID_BYTE_LENGTH = 4 + 32;

const KIND_CODE: Readonly<Record<CidKind, number>> = {
  record: 0x01,
  proof: 0x02,
  block: 0x03,
  chunk: 0x04,
};

const HUMAN_PREFIX: Readonly<Record<CidKind, string>> = {
  record: 'lcapr_',
  proof: 'lcapp_',
  block: 'lcapb_',
  chunk: 'lcapc_',
};

const KINDS = Object.keys(KIND_CODE) as CidKind[];

/** Why a CID string failed to parse (every check fails closed). */
export type CidErrorReason =
  | 'unknown_prefix'
  | 'bad_base32'
  | 'bad_length'
  | 'bad_version'
  | 'prefix_kind_mismatch'
  | 'bad_multihash';

export class CidError extends Error {
  override readonly name = 'CidError';
  readonly reason: CidErrorReason;
  constructor(reason: CidErrorReason, message?: string) {
    super(message ?? `invalid CID (${reason})`);
    this.reason = reason;
  }
}

/** A successfully parsed CID's structural components. */
export interface ParsedCid {
  readonly kind: CidKind;
  readonly kindCode: number;
  /** The raw 36-byte CID (version || kind || multihash || digest). */
  readonly bytes: Uint8Array;
  /** The 32-byte SHA-256 digest. */
  readonly digest: Uint8Array;
}

/** SHA-256 of `bytes` as a 32-byte digest (the primitive behind every CID). */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await getSubtle().digest('SHA-256', toBufferSource(bytes));
  return new Uint8Array(digest);
}

/** Build the raw 36-byte CID for `kind` over `bytes` (SHA-256 preimage). */
export async function cidBytesFor(kind: CidKind, bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await sha256(bytes);
  const out = new Uint8Array(CID_BYTE_LENGTH);
  out[0] = CID_FORMAT_VERSION;
  out[1] = KIND_CODE[kind];
  out[2] = MULTIHASH_SHA2_256;
  out[3] = SHA256_DIGEST_LEN;
  out.set(digest, 4);
  return out;
}

/** Build the human-readable CID string for `kind` over `bytes`. */
export async function cidFor(kind: CidKind, bytes: Uint8Array): Promise<string> {
  const cidBytes = await cidBytesFor(kind, bytes);
  return HUMAN_PREFIX[kind] + base32Encode(cidBytes);
}

/**
 * Parse and structurally validate a CID string.  Rejects (with the exact
 * `CidErrorReason`): an unknown human prefix; non-canonical base32; a wrong
 * length; a wrong format version; a human-prefix↔`kind_code` disagreement; and
 * a non-`0x12/0x20` multihash.
 */
export function parseCid(cid: string): ParsedCid {
  const kind = KINDS.find((k) => cid.startsWith(HUMAN_PREFIX[k]));
  if (!kind) throw new CidError('unknown_prefix');

  let bytes: Uint8Array;
  try {
    bytes = base32Decode(cid.slice(HUMAN_PREFIX[kind].length));
  } catch (error) {
    if (error instanceof Base32Error) throw new CidError('bad_base32', error.message);
    throw error;
  }

  if (bytes.length !== CID_BYTE_LENGTH) throw new CidError('bad_length');
  if (bytes[0] !== CID_FORMAT_VERSION) throw new CidError('bad_version');
  if (bytes[1] !== KIND_CODE[kind]) throw new CidError('prefix_kind_mismatch');
  if (bytes[2] !== MULTIHASH_SHA2_256 || bytes[3] !== SHA256_DIGEST_LEN) {
    throw new CidError('bad_multihash');
  }

  return { kind, kindCode: bytes[1], bytes, digest: bytes.slice(4) };
}

/** True iff `cid` is well-formed AND addresses exactly `bytes` for its kind. */
export async function verifyCid(cid: string, bytes: Uint8Array): Promise<boolean> {
  const parsed = parseCid(cid);
  const expected = await cidBytesFor(parsed.kind, bytes);
  return compareBytes(parsed.bytes, expected) === 0;
}
