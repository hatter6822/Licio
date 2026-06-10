// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scheduled retention + anonymization sweeps (WS-E.1.4, SPEC §22.4/§19.2/
// §19.3) — the mechanism that makes the retention tiers real. Every sweep is
// idempotent and batched: a partial run can be safely re-run, and an
// on-demand deletion (purgeAttention) shares the same delete paths so a
// request arriving mid-sweep is never lost.
//
//   retention.sweep.attention_raw       — raw rows older than 7 days (backstop;
//                                         raw rows should rarely exist at all);
//   retention.sweep.attention_aggregated — events past the per-user window are
//                                         deleted; §22.1 aggregate rows are
//                                         ANONYMIZED (identity → privacy
//                                         bucket) at the window and deleted at
//                                         the hard cap (audit-vs-minimization
//                                         balance);
//   retention.sweep.honor_preference    — purge-due rows (`none` preference =
//                                         ranking-window deadline) and ledger
//                                         entries past their owner's window;
//   retention.sweep.ranking_log         — ranking/invariant logs past 365 days;
//   retention.review.moderation         — moderation rows are FLAGGED for
//                                         annual human review, never
//                                         auto-deleted (legal-need retention).
//
// Jurisdiction overrides (WS-N) apply at job time and only ever SHORTEN a
// window. The sweep emits an audit record carrying counts only (no payloads),
// and `retentionComplianceReport` is the audit query proving no row exceeds
// its tier window.
import { getRetentionDays, type RetentionTier } from '@licio/shared';
import type { IdentityServices } from '../identity/services.js';
import { DAY_MS, RANKING_WINDOW_MS } from './privacy-gate.js';
import type { EventPipelineServices } from './services.js';

export interface RetentionSweepReport {
  attentionRawDeleted: number;
  attentionEventsDeleted: number;
  aggregatesAnonymized: number;
  aggregatesDeleted: number;
  anonymizedHardCapDeleted: number;
  purgeDueDeleted: number;
  ledgerDeleted: number;
  rankingLogDeleted: number;
  invariantOutputsDeleted: number;
  aggregationWindowsDeleted: number;
  moderationFlaggedForReview: number;
}

/** The effective maximum window for a tier after jurisdiction overrides. */
export function effectiveMaxDays(services: EventPipelineServices, tier: RetentionTier): number {
  const base = getRetentionDays(tier).max;
  const override = services.retention.overrides.maxDays?.[tier];
  // Overrides only ever shorten (data minimization can tighten, never loosen).
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return Math.min(base, override);
  }
  return base;
}

function isoDaysAgo(now: number, days: number): string {
  return new Date(now - days * DAY_MS).toISOString();
}

/** Drain a batched delete until it returns fewer rows than the batch size. */
async function drain(step: (limit: number) => Promise<number>, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    const removed = await step(batch);
    total += removed;
    if (removed < batch) return total;
  }
}

/** Run every retention sweep once. Idempotent; safe to re-run at any time. */
export async function runRetentionSweeps(
  events: EventPipelineServices,
  identity: IdentityServices,
  now: number = events.now(),
): Promise<RetentionSweepReport> {
  const batch = events.retention.batchSize;
  const report: RetentionSweepReport = {
    attentionRawDeleted: 0,
    attentionEventsDeleted: 0,
    aggregatesAnonymized: 0,
    aggregatesDeleted: 0,
    anonymizedHardCapDeleted: 0,
    purgeDueDeleted: 0,
    ledgerDeleted: 0,
    rankingLogDeleted: 0,
    invariantOutputsDeleted: 0,
    aggregationWindowsDeleted: 0,
    moderationFlaggedForReview: 0,
  };

  // 1. attention_raw backstop (<= 7 days; rows should rarely exist at all).
  report.attentionRawDeleted = await drain(
    (limit) =>
      events.eventStore.deleteTierOlderThan(
        'attention_raw',
        isoDaysAgo(now, effectiveMaxDays(events, 'attention_raw')),
        limit,
      ),
    batch,
  );

  // 2. attention_aggregated events past the tier maximum.
  report.attentionEventsDeleted = await drain(
    (limit) =>
      events.eventStore.deleteTierOlderThan(
        'attention_aggregated',
        isoDaysAgo(now, effectiveMaxDays(events, 'attention_aggregated')),
        limit,
      ),
    batch,
  );

  // 3. honor_preference: rows whose computed purge deadline has passed
  //    (`none` ⇒ the ranking window; `minimal` ⇒ the 90-day tier minimum).
  report.purgeDueDeleted = await drain(
    (limit) => events.eventStore.deletePurgeDue(new Date(now).toISOString(), limit),
    batch,
  );

  // 4. §22.1 aggregate rows: per-owner anonymize-or-delete at the CURRENT
  //    preference's window (a preference change mid-life is honored here).
  //    Settings are read in BATCHES (one query per 500 owners, not per owner).
  const aggregatedWindow = getRetentionDays('attention_aggregated');
  const tierMaxDays = effectiveMaxDays(events, 'attention_aggregated');
  const owners = await events.attentionStore.listIdentifiableOwners();
  const preferenceByOwner = new Map<string, string>();
  for (let offset = 0; offset < owners.length; offset += 500) {
    for (const user of await identity.store.getUsersByIds(owners.slice(offset, offset + 500))) {
      preferenceByOwner.set(user.userId, user.privacySettings.attention_retention_preference);
    }
  }
  for (const owner of owners) {
    const preference = preferenceByOwner.get(owner) ?? 'default';
    if (preference === 'none') {
      report.aggregatesDeleted += await events.attentionStore.deleteOwnedOlderThan(
        owner,
        new Date(now - RANKING_WINDOW_MS).toISOString(),
      );
    } else {
      const windowDays = Math.min(
        preference === 'minimal' ? aggregatedWindow.min : aggregatedWindow.max,
        tierMaxDays,
      );
      report.aggregatesAnonymized += await events.attentionStore.anonymizeOwnedOlderThan(
        owner,
        isoDaysAgo(now, windowDays),
      );
    }
  }
  // Anonymized rows persist only to the hard cap, then delete.
  report.anonymizedHardCapDeleted = await events.attentionStore.deleteAnonymizedOlderThan(
    isoDaysAgo(now, events.retention.anonymizedHardCapDays),
  );

  // 5. Signal Ledger retention coupling (WS-E.2.1d).
  report.ledgerDeleted = await events.ledgerStore.deletePurgeDue(new Date(now).toISOString());

  // 6. ranking_log: events + invariant outputs + aggregation windows.
  const rankingCutoff = isoDaysAgo(now, effectiveMaxDays(events, 'ranking_log'));
  report.rankingLogDeleted = await drain(
    (limit) => events.eventStore.deleteTierOlderThan('ranking_log', rankingCutoff, limit),
    batch,
  );
  report.invariantOutputsDeleted = await events.invariantStore.deleteOlderThan(rankingCutoff);
  report.aggregationWindowsDeleted = await events.windowStore.deleteOlderThan(rankingCutoff);

  // 7. moderation_legal: FLAG for annual review, never auto-delete.
  report.moderationFlaggedForReview = await drain(
    (limit) => events.eventStore.flagModerationForReview(isoDaysAgo(now, 365), limit),
    batch,
  );

  // Audit record: counts only, no payloads (WS-E.1.4 acceptance). Short keys,
  // privacy-critical counts first, so the bounded context field never loses
  // the numbers that matter (the full report is also structured-logged below).
  const summary = [
    `raw=${report.attentionRawDeleted}`,
    `evt=${report.attentionEventsDeleted}`,
    `agg(a=${report.aggregatesAnonymized},d=${report.aggregatesDeleted},h=${report.anonymizedHardCapDeleted})`,
    `purge=${report.purgeDueDeleted}`,
    `ledger=${report.ledgerDeleted}`,
    `rank(e=${report.rankingLogDeleted},i=${report.invariantOutputsDeleted},w=${report.aggregationWindowsDeleted})`,
    `modflag=${report.moderationFlaggedForReview}`,
  ].join(' ');
  await identity.audit.append({
    actorUserId: null,
    eventType: 'retention_sweep',
    context: { setting: 'retention_sweep', new_value: summary.slice(0, 256) },
  });
  events.log('events.retention.sweep', { ...report });
  return report;
}

export interface RetentionComplianceReport {
  /** Per-tier counts of rows past their effective window. ALL must be zero. */
  overRetained: Record<string, number>;
  compliant: boolean;
}

/**
 * The compliance audit query (WS-E.1.4 acceptance): verifies no stored row
 * exceeds its tier window. A transparency-report artifact (WS-P.2).
 */
export async function retentionComplianceReport(
  events: EventPipelineServices,
  now: number = events.now(),
): Promise<RetentionComplianceReport> {
  const overRetained: Record<string, number> = {};
  for (const tier of ['attention_raw', 'attention_aggregated', 'ranking_log'] as const) {
    overRetained[`events:${tier}`] = await events.eventStore.countTierOlderThan(
      tier,
      isoDaysAgo(now, effectiveMaxDays(events, tier)),
    );
  }
  overRetained['attention_aggregates:identifiable'] =
    await events.attentionStore.countIdentifiableOlderThan(
      isoDaysAgo(now, effectiveMaxDays(events, 'attention_aggregated')),
    );
  overRetained['signal_ledger:purge_due'] = await events.ledgerStore.countOverRetained(
    new Date(now).toISOString(),
  );
  overRetained['invariant_outputs:ranking_log'] = await events.invariantStore.countOlderThan(
    isoDaysAgo(now, effectiveMaxDays(events, 'ranking_log')),
  );
  const compliant = Object.values(overRetained).every((count) => count === 0);
  return { overRetained, compliant };
}

/**
 * The WS-D `onPrivacyChange` binding (SPEC §19.3): a retention-preference
 * change takes effect on EXISTING data by tightening purge deadlines (never
 * extending them). `none` ⇒ everything purges after the current ranking
 * window; `minimal` ⇒ deadlines tighten to now + the 90-day tier minimum.
 */
export async function applyRetentionPreferenceChange(
  events: EventPipelineServices,
  userId: string,
  preference: string,
  now: number = events.now(),
): Promise<void> {
  if (preference !== 'none' && preference !== 'minimal') return;
  const deadline =
    preference === 'none'
      ? new Date(now + RANKING_WINDOW_MS).toISOString()
      : new Date(now + getRetentionDays('attention_aggregated').min * DAY_MS).toISOString();
  await events.eventStore.tightenOwnerPurge(userId, 'attention_aggregated', deadline);
  await events.ledgerStore.tightenOwnerPurge(userId, deadline);
}

/**
 * The WS-D `purgeAttention` binding (SPEC §19.3 "delete attention history"):
 * remove every attention trace owned by the user — events, §22.1 aggregate
 * rows, and Signal Ledger entries. Real-time counters expire on their own
 * within the 2-hour TTL (bounded residual; they hold no durable state).
 * Returns the number of rows removed.
 */
export async function purgeUserAttention(
  events: EventPipelineServices,
  userId: string,
): Promise<number> {
  const eventsDeleted = await events.eventStore.deleteByOwner(userId);
  const aggregatesDeleted = await events.attentionStore.deleteByUser(userId);
  const ledgerDeleted = await events.ledgerStore.deleteByUser(userId);
  return eventsDeleted + aggregatesDeleted + ledgerDeleted;
}

/** Attention-bearing topics included in the DSAR attention export. */
const ATTENTION_EXPORT_TOPICS = ['attention.aggregate', 'source.opened.aggregate'] as const;

/**
 * The WS-D `exportAttention` binding (SPEC §19.3 DSAR export): the COMPLETE
 * set of the user's own attention data — every §22.1 aggregate row, every
 * Signal Ledger entry (paginated through, never truncated), and the user's
 * owned attention EVENTS (including source-open reports, which have no §22.1
 * projection). Pseudonymized (minimum-privacy) rows are already de-linked and
 * therefore not attributable to the export.
 */
export async function exportUserAttention(
  events: EventPipelineServices,
  userId: string,
): Promise<unknown[]> {
  const aggregates = await events.attentionStore.listByUser(userId);
  const ledger: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await events.ledgerStore.listForUser(userId, 500, cursor);
    ledger.push(...page.entries);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const attentionTopics = new Set<string>(ATTENTION_EXPORT_TOPICS);
  const attentionEvents = (await events.eventStore.listByOwner(userId))
    .filter((row) => attentionTopics.has(row.topic))
    .map((row) => ({ topic: row.topic, timestamp: row.timestamp, payload: row.payload }));
  return [
    { kind: 'attention_aggregates', rows: aggregates },
    { kind: 'signal_ledger', rows: ledger },
    { kind: 'attention_events', rows: attentionEvents },
  ];
}
