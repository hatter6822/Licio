// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — CLIENT-SIDE verified-dedup (the serverless cap, docs/private-p2p/
// TIER2-RENDEZVOUS-CAP.md §6.8). A polling member runs this over the (possibly flooded)
// presence set the relay returned and keeps ONLY records whose BBS proof verifies under
// the room's per-epoch issuer key, deduped by the VERIFIED pseudonym — so the relay is NOT
// trusted for the cap at all: the member enforces "one slot per device per (epoch, bucket)"
// LOCALLY, where the issuer key (roster) genuinely lives.
//
// This composes with — and does not replace — the server-side cap + the Tier-1 sample-poll:
// the sample-poll gives the client a fair sample to filter, and this guarantees the client
// never connects to (or is crowded by, in its own view) a record it cannot verify, even if
// the relay is malicious. It is the same pure verify the server runs; nothing here needs a
// server.

import { type G1Point, type G2Point, g1Bytes } from '../crypto/bbs/suite.js';
import {
  DEFAULT_BUCKET_WIDTH_MS,
  pseudonymFromBytes,
  rendezvousContext,
  rendezvousPresentationHeader,
  verifyRendezvousPresence,
} from './credential.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};

/** A polled presence record carrying its Tier-2 proof (e.g. extracted from the decrypted
 *  announcement) plus the caller's opaque payload (the dial info it actually wants). */
export interface VerifiablePresence<T> {
  /** The claimed pseudonym (48-byte compressed G1). */
  readonly pseudonym: Uint8Array;
  /** The BBS pseudonym-bound proof. */
  readonly proof: Uint8Array;
  /** The epoch the proof was made for. */
  readonly epoch: string;
  /** The time bucket (validated against the client's own clock), or -1 for per-epoch. */
  readonly bucket: number;
  /** The caller's payload (the decrypted announcement / signaling info). */
  readonly value: T;
  /**
   * The announcement's DIAL IDENTITY — the ephemeral signaling public key this record
   * publishes, taken from the OPENED announcement.
   *
   * The proof is bound to it (see `rendezvousContext`), so a proof lifted from another
   * device's record verifies against nothing here and cannot take that device's dedup
   * slot.  It must be the key from THIS record: verifying against a key chosen by the
   * caller would bind the proof to nothing at all.
   */
  readonly binding: Uint8Array;
}

export interface PollFilterOptions {
  /** The client's current time (ms). */
  readonly nowMs: number;
  /** Bucket width (must match the announcer / server). */
  readonly bucketWidthMs?: number;
  /** Prior buckets also accepted (boundary skew). */
  readonly bucketGrace?: number;
}

/** A verified, deduped presence: the parsed pseudonym + the caller's payload. */
export interface VerifiedPresence<T> {
  readonly pseudonym: G1Point;
  readonly value: T;
}

/**
 * From a polled (possibly flooded / relay-tampered) set, return only the records whose
 * proof verifies under `issuerKey` for `(roomBlindId, epoch, bucket)`, deduped by the
 * verified pseudonym (first occurrence wins) and bounded to the current time bucket
 * (± grace), or `-1` per-epoch. A non-member's fabricated record fails verification; a
 * member is bounded to one verified slot per `(epoch, bucket)` exactly as on the server.
 */
export function filterVerifiedPresence<T>(
  records: readonly VerifiablePresence<T>[],
  issuerKey: G2Point,
  roomBlindId: Uint8Array,
  options: PollFilterOptions,
): VerifiedPresence<T>[] {
  const width = options.bucketWidthMs ?? DEFAULT_BUCKET_WIDTH_MS;
  const grace = options.bucketGrace ?? 1;
  const current = Math.floor(options.nowMs / width);
  const seen = new Set<string>();
  const out: VerifiedPresence<T>[] = [];

  for (const record of records) {
    // Time-bucket window (the client's OWN clock — a flooder cannot mint a fresh bucket).
    if (record.bucket !== -1 && (record.bucket > current || record.bucket < current - grace)) {
      continue;
    }
    let nym: G1Point;
    try {
      nym = pseudonymFromBytes(record.pseudonym);
    } catch {
      continue; // malformed / identity pseudonym
    }
    // Dedup BY THE PARSED pseudonym bytes (canonical), so two encodings of the same nym
    // cannot occupy two slots.
    const key = hex(g1Bytes(nym));
    if (seen.has(key)) continue;
    const epochBytes = enc(record.epoch);
    const context = rendezvousContext(roomBlindId, epochBytes, record.bucket);
    if (
      !verifyRendezvousPresence(
        issuerKey,
        record.proof,
        nym,
        epochBytes,
        context,
        // Bound to THIS record's dial identity: a proof lifted from another
        // device's announcement verifies against nothing here, so it never
        // reaches the dedup below and cannot take that device's slot.
        rendezvousPresentationHeader(record.binding),
      )
    ) {
      continue;
    }
    seen.add(key);
    out.push({ pseudonym: nym, value: record.value });
  }
  return out;
}
