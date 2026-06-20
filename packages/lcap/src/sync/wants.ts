// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wants + range/resume fetch (OFFLINE_SPEC §16.8, §16.10, WS-R.6.4).  A want's
// `reason` drives its scheduling priority (trust/liveness gaps schedule as
// control; content as its natural lane).  Large blocks fetch by range and resume
// from the last verified chunk: the receiver verifies the reassembled block CID
// (done in `block/`), and `resumeFrom` computes the next range to request.  Pure
// functions; `buildWant` fails closed on a malformed CID.

import { parseCid } from '../cid/index.js';
import type { LcapPriority } from '../priority.js';
import { type WantRange, type WantRequestV2, wantRequestV2Schema } from '../schemas/sync.js';

/** The scheduling priority a want reason maps to (§15.1.1; lower = sooner). */
export function wantPriority(reason: WantRequestV2['reason']): LcapPriority {
  switch (reason) {
    case 'revocation_gap':
    case 'checkpoint_gap':
      return 0; // trust/liveness control — C0
    case 'missing_dependency':
    case 'explicit_user_request':
      return 1; // render-blocking text / user-driven — T1
    case 'room_interest':
    case 'resume_partial':
      return 2; // evidence/context — E2
    default:
      return 3; // scarce_replica — media-ish bulk — M3
  }
}

/** The effective priority of a want (its override, else its reason's priority). */
export function effectiveWantPriority(want: WantRequestV2): LcapPriority {
  return want.priority_override ?? wantPriority(want.reason);
}

/** Build + fail-closed-validate a want; `cid_kind` derives from the CID itself. */
export function buildWant(params: {
  readonly cid: string;
  readonly reason: WantRequestV2['reason'];
  readonly maxBytes?: number;
  readonly range?: WantRange;
  readonly priorityOverride?: LcapPriority;
}): WantRequestV2 {
  const want: Record<string, unknown> = {
    cid: params.cid,
    cid_kind: parseCid(params.cid).kind, // throws on a malformed CID (fail closed)
    reason: params.reason,
  };
  if (params.maxBytes !== undefined) want['max_bytes'] = params.maxBytes;
  if (params.range !== undefined) want['range'] = params.range;
  if (params.priorityOverride !== undefined) want['priority_override'] = params.priorityOverride;
  return wantRequestV2Schema.parse(want);
}

/**
 * The next byte range to request for a resumable fetch, or `undefined` when the
 * transfer is complete (§16.10).  Resumes from the first unverified byte and
 * requests at most `chunkSize` bytes (clamped to the remaining length), so an
 * interrupted transfer never re-fetches a verified chunk.
 */
export function resumeFrom(
  verifiedLength: number,
  totalLength: number,
  chunkSize: number,
): WantRange | undefined {
  if (chunkSize <= 0) throw new RangeError('chunkSize must be positive');
  if (verifiedLength < 0 || totalLength < 0) throw new RangeError('lengths must be non-negative');
  if (verifiedLength >= totalLength) return undefined;
  return { offset: verifiedLength, length: Math.min(chunkSize, totalLength - verifiedLength) };
}

/** Build a `resume_partial` want for the next range of a block (§16.8/§16.10). */
export function buildResumeWant(
  blockCid: string,
  verifiedLength: number,
  totalLength: number,
  chunkSize: number,
): WantRequestV2 | undefined {
  const range = resumeFrom(verifiedLength, totalLength, chunkSize);
  if (range === undefined) return undefined;
  return buildWant({ cid: blockCid, reason: 'resume_partial', range });
}
