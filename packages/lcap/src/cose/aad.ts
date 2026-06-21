// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Domain separation + external AAD builder (OFFLINE_SPEC §9.5, §10.2.2).  Every
// signature context carries a domain separator with a fixed grammar, and that
// separator is carried ONLY as the first element of an LDC-encoded context
// array — never hand-concatenated with payload bytes.  Because the array is
// LDC-encoded, the bound context (separator, protocol version, network id,
// record kind, proof kind) has exactly one byte representation, so a signature
// minted for one network / object kind / protocol version cannot validate in
// another.

import { encode } from '../cbor/encode.js';
import type { LdcValue } from '../cbor/types.js';

/** Protocol version carried in the AAD (§10.2.2). */
export const LCAP_PROTOCOL_VERSION = 2;

/** Object kinds permitted in a domain separator (§9.5). */
const OBJECT_KINDS: ReadonlySet<string> = new Set([
  'record',
  'proof',
  'checkpoint',
  'bundle',
  'receipt',
]);

/** `network_id` token grammar (§9.5): `[a-z0-9_-]+` (covers prod/staging/test). */
const NETWORK_ID = /^[a-z0-9_-]+$/;
/** `purpose` token grammar (§9.5): a lower_snake_case label. */
const PURPOSE = /^[a-z][a-z0-9_]*$/;

export type DomainSeparatorFailure = 'bad_network_id' | 'bad_object_kind' | 'bad_purpose';

export class DomainSeparatorError extends Error {
  override readonly name = 'DomainSeparatorError';
  readonly reason: DomainSeparatorFailure;
  constructor(reason: DomainSeparatorFailure) {
    super(`invalid domain separator token (${reason})`);
    this.reason = reason;
  }
}

/**
 * Build a §9.5 domain separator: `LCAP-v0.2:<network_id>:<object_kind>:<purpose>`.
 * Each token is validated against its grammar and rejected on any violation.
 */
export function domainSeparator(networkId: string, objectKind: string, purpose: string): string {
  if (!NETWORK_ID.test(networkId)) throw new DomainSeparatorError('bad_network_id');
  if (!OBJECT_KINDS.has(objectKind)) throw new DomainSeparatorError('bad_object_kind');
  if (!PURPOSE.test(purpose)) throw new DomainSeparatorError('bad_purpose');
  return `LCAP-v0.2:${networkId}:${objectKind}:${purpose}`;
}

export interface ExternalAadParams {
  /** The §9.5 separator string (built via `domainSeparator`). */
  readonly separator: string;
  /** Defaults to `LCAP_PROTOCOL_VERSION` (2). */
  readonly protocolVersion?: number;
  readonly networkId: string;
  readonly recordKind: string;
  readonly proofKind: string;
}

/**
 * LDC-encode the §10.2.2 fixed-shape context array
 * `[separator, protocol_version, network_id, record_kind, proof_kind]`.  The
 * result is byte-stable; changing any field perturbs the bytes (and therefore
 * the downstream signature).
 */
export function buildExternalAad(params: ExternalAadParams): Uint8Array {
  const value: LdcValue[] = [
    params.separator,
    params.protocolVersion ?? LCAP_PROTOCOL_VERSION,
    params.networkId,
    params.recordKind,
    params.proofKind,
  ];
  return encode(value);
}
