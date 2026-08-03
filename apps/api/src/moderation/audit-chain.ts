// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.5 — the moderation audit trail's tamper-EVIDENCE.
//
// Append-only and tamper-evident are different claims, and the trail only had the first.
// The trigger refuses UPDATE and DELETE through the ordinary path; it cannot speak for a
// superuser session, a restore from a doctored dump, or the next migration.  A chain can:
// every entry commits to its predecessor, so altering one invalidates every hash after it.
//
// KEYED, not a bare digest.  An unkeyed chain is recomputable by whoever can rewrite the
// table — it detects corruption and clerical error, and does nothing against an adversary,
// who simply recomputes the suffix.  The MAC key is derived from the identity master
// secret, so repairing the chain requires a secret the database does not hold.
//
// The preimage carries user identifiers as `accountRef` HMACs rather than raw UUIDs, the
// posture WS-N's compliance chains already take.  A hash that leaves this system must not
// double as an oracle for "was this person involved", and the verifier does not need the
// identity to check the arithmetic.
//
// The chain engine itself is `lib/hash-chain.ts` — shared with the treasury and compliance
// chains, whose own header says it exists so a second, divergent implementation does not
// grow.  This module supplies only the preimage and the verification predicate.
import { createHmac } from 'node:crypto';
import { AUDIT_NOTES_MAX } from '@licio/shared';
import { appendChainedWithRetry, verifyChainEntries } from '../lib/hash-chain.js';
import type { ModerationAuditRecord, ModerationAuditStore } from './stores.js';

/** The keyed digest of one entry, given a ref function for identifiers. */
export type AuditRefFn = (userId: string) => string;

/** Everything the hash commits to, in a fixed order. */
export function computeAuditEntryHash(
  entry: Omit<ModerationAuditRecord, 'integrityHash'>,
  key: string,
  refOf: AuditRefFn,
): string {
  const ref = (id: string | null): string => (id === null ? '-' : refOf(id));
  const preimage = [
    entry.prevHash ?? 'genesis',
    // The ORDINAL is in the preimage, so a row cannot be renumbered into a different
    // position without breaking its own hash — the chain and the sequence agree or
    // neither verifies.
    String(entry.ordinal),
    entry.eventTime,
    entry.action,
    entry.reasonCode ?? '-',
    entry.targetType,
    entry.targetId ?? '-',
    entry.priorState ?? '-',
    entry.nextState ?? '-',
    String(entry.reversible),
    entry.linkedActionId ?? '-',
    entry.caseId ?? '-',
    // Sorted: `reportIds` is a set, and its storage order must not change the hash.
    [...entry.reportIds].sort().join(','),
    entry.notes ?? '-',
    entry.actorRole ?? '-',
    ref(entry.actorUserId),
    ref(entry.subjectUserId),
    ref(entry.coApproverUserId),
    // The AT-MOST-ONCE key, and only when the row carries one.
    //
    // It is what the one-evidence-per-case guarantee rests on, so under this
    // chain's own threat model — a superuser or a doctored restore — leaving it
    // out means the key can be nulled and a second evidence row appended while
    // `verifyAuditChain` still reports the trail valid.
    //
    // APPENDED CONDITIONALLY so the change is backwards compatible: a row
    // without a key hashes exactly the bytes it always did, so every existing
    // entry still verifies. A keyed row whose key is later cleared no longer
    // recomputes to its stored hash, which is the detection this adds.
    ...(entry.idempotencyKey == null ? [] : [`idem:${entry.idempotencyKey}`]),
  ].join('\n');
  return `0x${createHmac('sha256', key).update(preimage, 'utf8').digest('hex')}`;
}

export interface AuditChainDeps {
  readonly store: ModerationAuditStore;
  /** The MAC key.  Derived from the identity master secret at wiring time. */
  readonly key: string;
  readonly refOf: AuditRefFn;
}

/** The marker a clamped note ends with — a reader must be able to tell a note
 *  that ends from one that was cut. */
const NOTE_TRUNCATION_MARK = '… [truncated]';

/**
 * `notes`, guaranteed renderable.
 *
 * The console reads every audit row through `auditRecordViewSchema`, whose
 * `notes` is bounded — so a longer note is stored happily and then fails the
 * parse on EVERY subsequent read of that case, taking the whole review panel
 * down with it (the report evidence that captured a room's 120-char name plus
 * its 2000-char description was exactly this: the case about that room became
 * unreadable, and therefore unactionable, because of the evidence attached to
 * it).
 *
 * The clamp lives HERE, in the single funnel every writer passes through
 * (`writeAudit`, `appendAudit` and the transactor's `tx.audit` all call this
 * function), so the invariant is structural: a row that can be stored can be
 * rendered.  It runs BEFORE hashing, so the chain covers what is actually kept.
 */
function fitNotes(notes: string | null): string | null {
  if (notes === null || notes.length <= AUDIT_NOTES_MAX) return notes;
  return notes.slice(0, AUDIT_NOTES_MAX - NOTE_TRUNCATION_MARK.length) + NOTE_TRUNCATION_MARK;
}

/**
 * Append one record, chained to the current head.
 *
 * Contention is arbitrated by the DB, not by a lock: two writers that read the same head
 * both claim the same parent, the fork-proof partial unique lets one land, and the loser
 * retries against the new head.  `appendChainedWithRetry` owns that loop.
 */
export async function appendChainedAudit(
  deps: AuditChainDeps,
  record: Omit<
    ModerationAuditRecord,
    'auditId' | 'ordinal' | 'eventTime' | 'createdAt' | 'prevHash' | 'integrityHash'
  >,
): Promise<ModerationAuditRecord> {
  return appendChainedWithRetry<ModerationAuditRecord>(
    {
      chainHead: () => deps.store.chainHead(),
      appendChained: (entry) =>
        deps.store.appendChained(entry, (staged) =>
          computeAuditEntryHash(staged, deps.key, deps.refOf),
        ),
    },
    // The ordinal and the event time are assigned by the STORE at insert, so the hash
    // cannot be computed out here — this stage fixes only the parent, and the store
    // calls back with the staged row once the values it owns exist.
    (prevHash) =>
      ({
        ...record,
        notes: fitNotes(record.notes),
        prevHash,
        integrityHash: null,
      }) as ModerationAuditRecord,
    'moderation audit',
  );
}

export interface AuditChainReport {
  valid: boolean;
  chainedEntries: number;
  problems: string[];
}

/**
 * Verify the whole chain.
 *
 * Two failure modes matter and the generic verifier only covers the first:
 *
 *   1. An entry that does not recompute, a fork, an orphan, a missing genesis — the
 *      shared `verifyChainEntries` predicate.
 *   2. An UNCHAINED row appended after the chain began.  Nothing about it is
 *      individually wrong; it is simply not in the chain, which is exactly what a row
 *      inserted around the application would look like.  Rows written BEFORE migration
 *      0118 are legitimately unchained, so the boundary is the genesis ordinal: after
 *      it, every row must be chained.
 */
export function verifyAuditChain(
  entries: readonly ModerationAuditRecord[],
  key: string,
  refOf: AuditRefFn,
): AuditChainReport {
  const chained = entries.filter((e) => e.integrityHash !== null);
  const base = verifyChainEntries(chained, {
    id: (e) => e.auditId,
    recompute: (e) => computeAuditEntryHash(e, key, refOf),
  });
  const problems = [...base.problems];
  const genesis = chained.find((e) => e.prevHash === null);
  if (genesis !== undefined) {
    for (const entry of entries) {
      if (entry.ordinal > genesis.ordinal && entry.integrityHash === null) {
        problems.push(
          `entry ${entry.auditId} (ordinal ${entry.ordinal}) is UNCHAINED after the genesis at ordinal ${genesis.ordinal}`,
        );
      }
    }
  }
  return { valid: problems.length === 0, chainedEntries: base.chainedEntries, problems };
}
