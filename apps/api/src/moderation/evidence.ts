// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ROLE_EVIDENCE surface (STEWARD_ROLES.md; SPEC §16.3): the evidence
// queue — citation-bearing contributions (sourced comments + corrections)
// awaiting an evidence steward's review — and the two doctrine actions,
// `mark-primary-source` and `flag-citation`, plus the `clear` queue workflow
// (reviewed, no annotation).
//
// Decisions are evidence METADATA, never content actions: this module holds
// no content-removal power by construction (it never touches a moderation
// state, only the append-only decision store + the audit log).  Decisions
// surface through the moderation console's evidence panels (the former
// public independent-sources drawer projection was removed — comment-centric
// sourcing superseded story-level lineage).
//
// The queue is DERIVED, not intake-driven: pending = citation-bearing
// PUBLISHED contributions with no decision row yet.  Deriving from the store
// cannot drift from reality (an intake consumer could miss events); the
// cursor advances over already-decided rows exactly like the subtree reads
// advance over invisible rows.
import type {
  EvidenceDecisionRequest,
  EvidenceDecisionView,
  EvidenceQueueResponse,
  EvidenceQueueRow,
} from '@licio/shared';
import { writeAudit } from './audit.js';
import { denyCapability, denyQueue, type StewardActor } from './authz.js';
import type { ModerationServices } from './services.js';
import type { EvidenceDecisionRecord } from './stores.js';

/** Bound on rows scanned per queue page (decided rows are skipped, so one
 *  page may scan more candidates than it returns). */
const QUEUE_SCAN_CAP = 500;

const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt}|${id}`, 'utf-8').toString('base64url');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decode + SHAPE-VALIDATE a keyset cursor.  A malformed cursor (garbage
 *  base64, non-timestamp, non-uuid) restarts from the beginning — the
 *  defensive branchContent semantics, never a 500 from a failed `::uuid`
 *  cast inside the store. */
const decodeCursor = (cursor: string): { createdAt: string; id: string } | null => {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
  if (!createdAt || !id) return null;
  if (!Number.isFinite(Date.parse(createdAt)) || !UUID_RE.test(id)) return null;
  return { createdAt, id };
};

/**
 * The evidence queue (oldest first, FIFO): citation-bearing published
 * contributions with no decision yet.  The cursor encodes the last SCANNED
 * candidate, so pagination advances even when a whole page was already
 * decided.
 */
export async function buildEvidenceQueue(
  mod: ModerationServices,
  opts: { cursor?: string | undefined; limit: number },
): Promise<EvidenceQueueResponse> {
  const listCited = mod.content.listCitedContributions?.bind(mod.content);
  if (!listCited) return { items: [], next_cursor: null };

  const items: EvidenceQueueRow[] = [];
  let after = opts.cursor ? decodeCursor(opts.cursor) : null;
  let scanned = 0;
  let exhausted = false;
  while (items.length < opts.limit && scanned < QUEUE_SCAN_CAP) {
    const batchSize = Math.min(Math.max(opts.limit * 2, 25), QUEUE_SCAN_CAP - scanned);
    const batch = await listCited({ after, limit: batchSize });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    scanned += batch.length;
    const decided = await mod.evidenceDecisions.decidedContributionIds(
      batch.map((c) => c.contributionId),
    );
    for (const candidate of batch) {
      if (decided.has(candidate.contributionId) || candidate.threadRemoved) continue;
      items.push({
        contribution_id: candidate.contributionId,
        thread_id: candidate.threadId,
        story_id: candidate.storyId,
        story_title: candidate.storyTitle,
        type: candidate.type,
        body_preview: candidate.bodyPreview.slice(0, 280),
        citations: candidate.citations.slice(0, 10),
        created_at: candidate.createdAt,
      });
      if (items.length >= opts.limit) break;
    }
    const lastScanned =
      items.length >= opts.limit
        ? // Resume from the last RETURNED row (unreturned scanned rows must
          // reappear on the next page).
          {
            createdAt: items[items.length - 1]?.created_at ?? '',
            id: items[items.length - 1]?.contribution_id ?? '',
          }
        : {
            createdAt: batch[batch.length - 1]?.createdAt ?? '',
            id: batch[batch.length - 1]?.contributionId ?? '',
          };
    after = lastScanned.createdAt
      ? { createdAt: lastScanned.createdAt, id: lastScanned.id }
      : after;
    if (batch.length < batchSize && items.length < opts.limit) {
      exhausted = true;
      break;
    }
  }
  const next_cursor = !exhausted && after !== null ? encodeCursor(after.createdAt, after.id) : null;
  return { items, next_cursor };
}

export type EvidenceDecisionOutcome =
  | { ok: true; record: EvidenceDecisionRecord }
  | {
      ok: false;
      code:
        | 'insufficient_capability'
        | 'mfa_required'
        | 'target_not_found'
        | 'citation_not_found'
        | 'citation_malicious'
        | 'duplicate_decision';
      message: string;
    };

/**
 * Apply an evidence decision.  Authorization is doctrine-shaped: the two
 * citation actions require their EXACT capability grant
 * (`mark-primary-source` / `flag-citation` — ROLE_EVIDENCE only); `clear` is
 * queue workflow, inherent to evidence-queue ACCESS (parity with the report
 * queue's clear, which STEWARD_ROLE_CAPABILITIES extends to report-queue
 * roles).  Every decision is audited under the doctrine action id.
 */
export async function applyEvidenceDecision(
  mod: ModerationServices,
  actor: StewardActor,
  request: EvidenceDecisionRequest,
): Promise<EvidenceDecisionOutcome> {
  const denial =
    request.action === 'clear'
      ? denyQueue(actor, 'evidence-queue')
      : denyCapability(actor, request.action);
  if (denial) return { ok: false, code: denial.code, message: denial.message };

  const getCited = mod.content.getCitedContribution?.bind(mod.content);
  const target = getCited ? await getCited(request.contribution_id) : null;
  if (!target) {
    return {
      ok: false,
      code: 'target_not_found',
      message: 'No citation-bearing contribution with that id',
    };
  }
  const citationUrl = request.citation_url ?? null;
  if (citationUrl !== null && !target.citations.some((c) => c.url === citationUrl)) {
    return {
      ok: false,
      code: 'citation_not_found',
      message: 'citation_url must be one of the contribution’s own citations',
    };
  }
  // Promoting a citation to the PUBLIC primary-source surface is the one
  // console action that must not skip the malware check: a KNOWN-malicious
  // destination is refused outright.  `unavailable` (or an unwired seam)
  // proceeds on steward judgment — the reader-side drainer-safe link flow
  // still guards every click — and doi: references have no fetchable
  // destination to check.
  if (
    request.action === 'mark-primary-source' &&
    citationUrl !== null &&
    /^https?:\/\//i.test(citationUrl) &&
    mod.urlVerdict
  ) {
    const verdict = await mod.urlVerdict(citationUrl);
    if (verdict === 'malicious') {
      mod.metrics.increment('moderation.evidence.mark_primary_source_malicious');
      return {
        ok: false,
        code: 'citation_malicious',
        message: 'This citation resolves to a known malicious destination',
      };
    }
  }
  const citationTitle =
    citationUrl !== null
      ? (target.citations.find((c) => c.url === citationUrl)?.title ?? null)
      : null;
  const inserted = await mod.evidenceDecisions.insert({
    contributionId: target.contributionId,
    threadId: target.threadId,
    storyId: target.storyId,
    action: request.action,
    citationUrl,
    citationTitle,
    reasonCode: request.reason_code ?? null,
    note: request.note ?? null,
    decidedBy: actor.userId,
  });
  if (!inserted.ok) {
    return {
      ok: false,
      code: 'duplicate_decision',
      message: 'An identical evidence decision already exists for this citation',
    };
  }
  // Audited under the doctrine action id ("actions audited; evidence
  // decisions reviewable").  No subject user: this annotates CONTENT
  // metadata, never sanctions an account (no user notice — not a
  // significant action per WS-J.2.3a).
  await writeAudit(mod, {
    actorUserId: actor.userId,
    actorRole: actor.stewardRoles.includes('ROLE_EVIDENCE')
      ? 'ROLE_EVIDENCE'
      : (actor.stewardRoles[0] ?? null),
    action: request.action === 'clear' ? 'evidence_clear' : request.action,
    targetType: 'content',
    targetId: target.contributionId,
    subjectUserId: null,
    reasonCode: request.reason_code ?? null,
    notes: request.note ?? null,
  });
  mod.metrics.increment(`moderation.evidence.${request.action.replaceAll('-', '_')}`);
  return { ok: true, record: inserted.record };
}

/** Project decisions to the console view (handles resolved by the caller). */
export function decisionToView(
  record: EvidenceDecisionRecord,
  handles: ReadonlyMap<string, string | null>,
): EvidenceDecisionView {
  return {
    decision_id: record.decisionId,
    contribution_id: record.contributionId,
    story_id: record.storyId,
    action: record.action,
    citation_url: record.citationUrl,
    // Stored codes were validated at the write boundary (the request schema's
    // ratified-code refinement); the store field is a plain string column.
    reason_code: record.reasonCode as EvidenceDecisionView['reason_code'],
    note: record.note,
    decided_by_handle: record.decidedBy === null ? null : (handles.get(record.decidedBy) ?? null),
    created_at: record.createdAt,
  };
}

// (The former `primarySourcesForStory` public projection was removed with the
// independent-sources drawer, its only consumer — comment-centric sourcing
// superseded story-level lineage. The steward mark-primary-source DECISIONS
// are unchanged: they persist as audited evidence metadata and stay visible
// through the moderation console's evidence surfaces.)
