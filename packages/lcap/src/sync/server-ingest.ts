// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server ingestion orchestrator (OFFLINE_SPEC §24.1, §24.2, §24.5, WS-R.12.1c).
// The §24.1 commit-stage DECISION, composed from the already-shipped pure
// primitives: the idempotency pre-gate (WS-R.6.5), the SAME `validate()` the
// client runs projected through the §25.1 conflict table (WS-R.13.1), the
// room-log-append gate, the receipt-issuance decision (WS-R.10.2), and the wants
// for missing dependencies (WS-R.6.4).  A server route runs `validate(record)`
// then calls this; the CAS write, the transactional room-log append, and the
// receipt signing are the deferred I/O binding (WS-R.12.2/12.4).
//
// The §24.2 "never emit before validation" rule is structural here:
// `appendToRoomLog` is true ONLY for a freshly-`accepted` record, so a
// quarantined/rejected/conflicting record can never reach the canonical log.

import { type CidKind, parseCid } from '../cid/index.js';
import { type ConflictSituation, dispatchConflict } from '../conflict/dispatch.js';
import type { ObjectStatusCode } from '../pack/status.js';
import type { ReceiptRecordV2 } from '../schemas/receipt.js';
import type { WantRequestV2 } from '../schemas/sync.js';

/** The receipt type to authenticate an outcome, or `undefined` for none (§24.5). */
export type IngestionReceiptType = ReceiptRecordV2['receipt_type'] | undefined;

export interface IngestionInput {
  /** §16.9 idempotency: we already hold this `record_cid` accepted (an equivalent proof verifies). */
  readonly alreadyHave: boolean;
  /** The validation outcome + fork signals (WS-R.13 `ConflictSituation`). */
  readonly situation: ConflictSituation;
}

export interface IngestionOutcome {
  /** The per-object §16.11 status. */
  readonly status: ObjectStatusCode;
  /** Append to the canonical room log? True ONLY for a freshly-accepted record (§24.2). */
  readonly appendToRoomLog: boolean;
  /** The receipt to issue for this outcome (§24.5), or `undefined` for none. */
  readonly issueReceipt: IngestionReceiptType;
  /** Wants for the precise missing dependencies (only when quarantined-missing). */
  readonly wants: readonly WantRequestV2[];
  /** The unmet dependency CIDs (for the quarantine status). */
  readonly missingCids: readonly string[];
  /** Keep the body as untrusted forensic material (bad signature; never rendered). */
  readonly keepForensic: boolean;
  /** Create + gossip fork evidence (device / checkpoint fork). */
  readonly gossipForkEvidence: boolean;
}

/** Map a final status to the receipt type to issue (§24.5). */
function receiptForStatus(status: ObjectStatusCode): IngestionReceiptType {
  if (status === 'accepted' || status === 'already_have') return 'accepted';
  if (status === 'stored_pending' || status === 'stored_unverified') return 'stored';
  if (status.startsWith('quarantined_')) return 'quarantined';
  if (status.startsWith('rejected_')) return 'rejected';
  return undefined; // conflict_device_fork → fork evidence is gossiped, not receipted
}

/**
 * The well-formed, fetchable-by-CID subset of a raw `missingCids` set, each paired with
 * its CID kind (§16.8).  `validate()` reports some missing dependencies as DIAGNOSTIC
 * pseudo-keys rather than content CIDs — a missing signer key (`signer_key:<id>`), device
 * certificate (`device_certificate:<id>`), proof (`proof_for:<cid>`), or authority key
 * (`account_authority_key:…` / `room_authority_key:…`).  None of those is a content object
 * the peer can send by CID, and each is invalid under `anyCidSchema`, so they MUST NOT
 * reach the wire `missing_cids`/`want` fields — a single one would throw the whole
 * `ObjectStatusV2` / exchange-response parse.  This is the single chokepoint that keeps
 * BOTH wire projections (the wants AND the reported `missingCids`) CID-clean.
 */
function fetchableMissing(
  missingCids: readonly string[],
): readonly { cid: string; kind: CidKind }[] {
  const out: { cid: string; kind: CidKind }[] = [];
  for (const cid of missingCids) {
    try {
      out.push({ cid, kind: parseCid(cid).kind });
    } catch {
      // a diagnostic pseudo-key or malformed CID — never fetchable by CID, never on the wire
    }
  }
  return out;
}

/**
 * Decide the ingestion outcome for one record (§24.1 commit stage).  Idempotent
 * by `record_cid` (an identical re-submit returns `already_have` and never
 * re-appends); otherwise the validation outcome is projected through the §25.1
 * conflict table and the canonical-emission / receipt / wants decisions follow.
 * Pure — the caller performs the CAS write, the transactional append, and the
 * receipt signing.
 */
export function ingestRecord(input: IngestionInput): IngestionOutcome {
  if (input.alreadyHave) {
    return {
      status: 'already_have',
      appendToRoomLog: false, // already in the canonical log
      issueReceipt: 'accepted',
      wants: [],
      missingCids: [],
      keepForensic: false,
      gossipForkEvidence: false,
    };
  }

  const outcome = dispatchConflict(input.situation);
  const { status } = outcome;
  // Project only the well-formed CID subset onto the wire: both `missingCids` and the
  // derived `wants` are `anyCidSchema`-clean, so a quarantine for a missing IDENTITY
  // dependency (a proof/cert/key, which validate() reports as a non-CID pseudo-key) can
  // never throw the `ObjectStatusV2` / exchange-response parse — the peer sees an honest
  // `quarantined_missing_dependency` with no fetchable CID and re-sends the identity closure.
  const fetchable = fetchableMissing(outcome.missingCids ?? []);
  return {
    status,
    appendToRoomLog: status === 'accepted',
    issueReceipt: receiptForStatus(status),
    wants:
      status === 'quarantined_missing_dependency'
        ? fetchable.map(
            (f): WantRequestV2 => ({ cid: f.cid, cid_kind: f.kind, reason: 'missing_dependency' }),
          )
        : [],
    missingCids: fetchable.map((f) => f.cid),
    keepForensic: outcome.keepForensic ?? false,
    gossipForkEvidence: outcome.gossipForkEvidence ?? false,
  };
}
