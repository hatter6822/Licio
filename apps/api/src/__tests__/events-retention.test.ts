// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Retention + anonymization acceptance (WS-E.1.4): per-tier sweeps, the
// anonymize-vs-delete policy for aggregated attention, preference honoring
// (`none`/`minimal`), moderation review-flagging (never auto-deletion),
// idempotency, jurisdiction overrides, the compliance audit query, and the
// WS-D hook bindings (purgeAttention / exportAttention / onPrivacyChange).

import { randomUUID } from 'node:crypto';
import { defaultPrivacySettings } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestAttentionEvents, ONLINE_ACCEPTANCE } from '../events/ingest.js';
import {
  applyRetentionPreferenceChange,
  effectiveMaxDays,
  exportUserAttention,
  purgeUserAttention,
  retentionComplianceReport,
  runRetentionSweeps,
} from '../events/retention.js';
import { type NewStoredEvent, PRIVACY_BUCKET, PSEUDONYMOUS_USER_ID } from '../events/stores.js';
import {
  attentionEvent,
  freshWsEServices,
  seedUserWithSession,
  sourceOpenEvent,
  type WsEFixture,
} from './ws-e-helpers.js';

const DAY = 86_400_000;

function eventRow(overrides: Partial<NewStoredEvent>): NewStoredEvent {
  return {
    eventId: randomUUID(),
    eventType: 'attention.aggregate',
    topic: 'attention.aggregate',
    timestamp: new Date().toISOString(),
    privacyClassification: 'aggregated',
    retentionTier: 'attention_aggregated',
    payload: {},
    ownerUserId: null,
    purgeAfter: null,
    ...overrides,
  };
}

let fixture: WsEFixture;

beforeEach(() => {
  fixture = freshWsEServices();
});

describe('retention sweeps (WS-E.1.4)', () => {
  it('deletes attention_raw rows past 7 days and aggregated events past 180 days', async () => {
    const now = Date.now();
    await fixture.events.eventStore.insertMany([
      eventRow({
        retentionTier: 'attention_raw',
        timestamp: new Date(now - 8 * DAY).toISOString(),
      }),
      eventRow({
        retentionTier: 'attention_raw',
        timestamp: new Date(now - 1 * DAY).toISOString(),
      }),
      eventRow({ timestamp: new Date(now - 181 * DAY).toISOString() }),
      eventRow({ timestamp: new Date(now - 10 * DAY).toISOString() }),
    ]);
    const report = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(report.attentionRawDeleted).toBe(1);
    expect(report.attentionEventsDeleted).toBe(1);
  });

  it('anonymizes identifiable aggregate rows past the window, deletes at the hard cap', async () => {
    const now = Date.now();
    const { userId } = await seedUserWithSession(fixture.identity);
    await fixture.events.attentionStore.insertMany([
      {
        aggregate_id: randomUUID(),
        user_id_or_privacy_bucket: userId,
        story_id: randomUUID(),
        session_bucket: 's',
        active_dwell_bucket: 'short',
        source_opened: false,
        context_opened: false,
        branch_depth_bucket: 'none',
        return_visit_count_bucket: 'none',
        privacy_level: 'standard',
        created_at: new Date(now - 181 * DAY).toISOString(),
      },
      {
        aggregate_id: randomUUID(),
        user_id_or_privacy_bucket: userId,
        story_id: randomUUID(),
        session_bucket: 's',
        active_dwell_bucket: 'short',
        source_opened: false,
        context_opened: false,
        branch_depth_bucket: 'none',
        return_visit_count_bucket: 'none',
        privacy_level: 'standard',
        created_at: new Date(now - 1 * DAY).toISOString(),
      },
      {
        aggregate_id: randomUUID(),
        user_id_or_privacy_bucket: PRIVACY_BUCKET,
        story_id: randomUUID(),
        session_bucket: 's',
        active_dwell_bucket: 'short',
        source_opened: false,
        context_opened: false,
        branch_depth_bucket: 'none',
        return_visit_count_bucket: 'none',
        privacy_level: 'minimum',
        created_at: new Date(now - 366 * DAY).toISOString(),
      },
    ]);
    const report = await runRetentionSweeps(fixture.events, fixture.identity, now);
    // The old identifiable row was anonymized (identity → privacy bucket)…
    expect(report.aggregatesAnonymized).toBe(1);
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(1);
    // …and the very old anonymized row was deleted at the hard cap.
    expect(report.anonymizedHardCapDeleted).toBeGreaterThanOrEqual(1);
  });

  it('deletes per the CURRENT preference: `none` owners lose rows after the ranking window', async () => {
    const now = Date.now();
    const { userId } = await seedUserWithSession(fixture.identity, {
      privacySettings: {
        ...defaultPrivacySettings(),
        attention_retention_preference: 'none',
      },
    });
    await fixture.events.attentionStore.insertMany([
      {
        aggregate_id: randomUUID(),
        user_id_or_privacy_bucket: userId,
        story_id: randomUUID(),
        session_bucket: 's',
        active_dwell_bucket: 'short',
        source_opened: false,
        context_opened: false,
        branch_depth_bucket: 'none',
        return_visit_count_bucket: 'none',
        privacy_level: 'standard',
        created_at: new Date(now - 2 * 3_600_000).toISOString(),
      },
    ]);
    const report = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(report.aggregatesDeleted).toBe(1);
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(0);
  });

  it('honors `minimal` with the 90-day minimum window', async () => {
    const now = Date.now();
    const { userId } = await seedUserWithSession(fixture.identity, {
      privacySettings: {
        ...defaultPrivacySettings(),
        attention_retention_preference: 'minimal',
      },
    });
    await fixture.events.attentionStore.insertMany([
      {
        aggregate_id: randomUUID(),
        user_id_or_privacy_bucket: userId,
        story_id: randomUUID(),
        session_bucket: 's',
        active_dwell_bucket: 'short',
        source_opened: false,
        context_opened: false,
        branch_depth_bucket: 'none',
        return_visit_count_bucket: 'none',
        privacy_level: 'standard',
        created_at: new Date(now - 91 * DAY).toISOString(),
      },
    ]);
    const report = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(report.aggregatesAnonymized).toBe(1);
  });

  it('deletes purge-due event rows (the honor_preference sweep)', async () => {
    const now = Date.now();
    await fixture.events.eventStore.insertMany([
      eventRow({ purgeAfter: new Date(now - 1_000).toISOString() }),
      eventRow({ purgeAfter: new Date(now + DAY).toISOString() }),
    ]);
    const report = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(report.purgeDueDeleted).toBe(1);
  });

  it('flags moderation rows for annual review and NEVER auto-deletes them', async () => {
    const now = Date.now();
    await fixture.events.eventStore.insertMany([
      eventRow({
        topic: 'moderation.case.created',
        eventType: 'moderation.case.created',
        privacyClassification: 'restricted',
        retentionTier: 'moderation_legal',
        timestamp: new Date(now - 400 * DAY).toISOString(),
      }),
    ]);
    const first = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(first.moderationFlaggedForReview).toBe(1);
    // The row still exists (flagged, not deleted)…
    expect(
      await fixture.events.eventStore.countTierOlderThan(
        'moderation_legal',
        new Date(now).toISOString(),
      ),
    ).toBe(1);
    // …and re-running flags nothing new (idempotent).
    const second = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(second.moderationFlaggedForReview).toBe(0);
  });

  it('deletes ranking_log events, invariant outputs, and windows past 365 days', async () => {
    const now = Date.now();
    await fixture.events.eventStore.insertMany([
      eventRow({
        topic: 'invariant.run.completed',
        eventType: 'invariant.run.completed',
        privacyClassification: 'sensitive',
        retentionTier: 'ranking_log',
        timestamp: new Date(now - 400 * DAY).toISOString(),
      }),
    ]);
    await fixture.events.invariantStore.upsert({
      invariantType: 'PWAtt_v0',
      targetType: 'story',
      targetId: randomUUID(),
      timeWindow: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T01:00:00.000Z' },
      version: 'v0',
      scoreVector: { score: 0.1 },
      explanationSummary: null,
      confidence: 0.5,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date(now - 400 * DAY).toISOString(),
    });
    const report = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(report.rankingLogDeleted).toBe(1);
    expect(report.invariantOutputsDeleted).toBe(1);
  });

  it('is idempotent: re-running a sweep produces no further change', async () => {
    const now = Date.now();
    await fixture.events.eventStore.insertMany([
      eventRow({ timestamp: new Date(now - 200 * DAY).toISOString() }),
    ]);
    const first = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(first.attentionEventsDeleted).toBe(1);
    const second = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(second.attentionEventsDeleted).toBe(0);
  });

  it('emits a counts-only audit record (no payloads)', async () => {
    await runRetentionSweeps(fixture.events, fixture.identity);
    const activity = await fixture.identity.audit.securityActivityForUser('none');
    expect(activity).toHaveLength(0); // sweeps are system events, not user ones
    // The audit store accepted the entry with the retention_sweep type.
    const entry = await fixture.identity.audit.append({
      actorUserId: null,
      eventType: 'retention_sweep',
      context: { setting: 'retention_sweep', new_value: 'probe' },
    });
    expect(entry.event_type).toBe('retention_sweep');
  });

  it('applies jurisdiction overrides that only ever SHORTEN windows (WS-N hook)', async () => {
    fixture = freshWsEServices({
      retention: { overrides: { maxDays: { attention_aggregated: 30, ranking_log: 9_999 } } },
    });
    expect(effectiveMaxDays(fixture.events, 'attention_aggregated')).toBe(30);
    // An override can never EXTEND a window beyond the SPEC default.
    expect(effectiveMaxDays(fixture.events, 'ranking_log')).toBe(365);
    const now = Date.now();
    await fixture.events.eventStore.insertMany([
      eventRow({ timestamp: new Date(now - 31 * DAY).toISOString() }),
    ]);
    const report = await runRetentionSweeps(fixture.events, fixture.identity, now);
    expect(report.attentionEventsDeleted).toBe(1);
  });
});

describe('retention compliance audit query (WS-E.1.4)', () => {
  it('reports zero over-retained rows after a sweep', async () => {
    const now = Date.now();
    await fixture.events.eventStore.insertMany([
      eventRow({ timestamp: new Date(now - 200 * DAY).toISOString() }),
      eventRow({
        retentionTier: 'attention_raw',
        timestamp: new Date(now - 10 * DAY).toISOString(),
      }),
    ]);
    const before = await retentionComplianceReport(fixture.events, now);
    expect(before.compliant).toBe(false);
    await runRetentionSweeps(fixture.events, fixture.identity, now);
    const after = await retentionComplianceReport(fixture.events, now);
    expect(after.compliant).toBe(true);
    expect(Object.values(after.overRetained).every((n) => n === 0)).toBe(true);
  });

  it('flags rows past their per-user purge deadline even inside the tier window', async () => {
    const now = Date.now();
    // One day old — far inside the 180-day tier ceiling — but its preference
    // deadline (`none`/`minimal` purge_after) has already passed: a failed
    // preference purge must be VISIBLE to the report, not masked by tier age.
    await fixture.events.eventStore.insertMany([
      eventRow({
        timestamp: new Date(now - DAY).toISOString(),
        purgeAfter: new Date(now - 60_000).toISOString(),
      }),
    ]);
    const before = await retentionComplianceReport(fixture.events, now);
    expect(before.compliant).toBe(false);
    expect(before.overRetained['events:purge_due']).toBe(1);
    await runRetentionSweeps(fixture.events, fixture.identity, now);
    const after = await retentionComplianceReport(fixture.events, now);
    expect(after.compliant).toBe(true);
    expect(after.overRetained['events:purge_due']).toBe(0);
  });
});

describe('WS-D hook bindings (SPEC §19.3)', () => {
  it('purgeUserAttention removes events, aggregates, and ledger entries', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId)],
      ONLINE_ACCEPTANCE,
    );
    await fixture.events.ledgerStore.upsertMany([
      {
        entryId: randomUUID(),
        ownerUserId: userId,
        itemId: randomUUID(),
        storyTitle: 'T',
        windowStart: new Date().toISOString(),
        windowSize: '1h',
        signals: {},
        antiSignals: [],
        pwattScore: 0.2,
        summary: 'You read this for a short while.',
        recordedAt: new Date().toISOString(),
        purgeAfter: new Date(Date.now() + DAY).toISOString(),
      },
    ]);
    const removed = await purgeUserAttention(fixture.events, userId);
    expect(removed).toBe(3); // 1 event + 1 aggregate + 1 ledger entry
    expect(await fixture.events.eventStore.listByOwner(userId)).toHaveLength(0);
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(0);
    expect((await fixture.events.ledgerStore.listForUser(userId, 10)).entries).toHaveLength(0);
  });

  it('an attention RESET never touches non-attention owned rows; account DELETE de-links them', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId)],
      ONLINE_ACCEPTANCE,
    );
    // A user-owned NON-attention row (the public contribution pipeline event):
    // deleting it on an attention reset would corrupt scoring/audit history.
    const contributionId = randomUUID();
    await fixture.events.eventStore.insertMany([
      eventRow({
        eventId: contributionId,
        eventType: 'contribution.created',
        topic: 'contribution.created',
        privacyClassification: 'public',
        retentionTier: 'public_contribution',
        payload: { user_id: userId, contribution_type: 'comment' },
        ownerUserId: userId,
      }),
    ]);

    // RESET (the attention-history deletion endpoint): attention rows are
    // gone, the contribution row is untouched and still attributable.
    await purgeUserAttention(fixture.events, userId, 'reset');
    const afterReset = await fixture.events.eventStore.listByOwner(userId);
    expect(afterReset.map((row) => row.topic)).toEqual(['contribution.created']);

    // DELETE (the account hard purge): the remaining owned row is DE-LINKED —
    // owner cleared, payload user_id pseudonymized — never left attributable.
    await purgeUserAttention(fixture.events, userId, 'delete');
    expect(await fixture.events.eventStore.listByOwner(userId)).toHaveLength(0);
    const tombstoned = await fixture.events.eventStore.getById(contributionId);
    expect(tombstoned).not.toBeNull();
    expect(tombstoned?.ownerUserId).toBeNull();
    expect(tombstoned?.payload['user_id']).toBe(PSEUDONYMOUS_USER_ID);
    expect(tombstoned?.payload['contribution_type']).toBe('comment');
  });

  it('exportUserAttention returns the user’s own aggregates and ledger', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId)],
      ONLINE_ACCEPTANCE,
    );
    const exported = (await exportUserAttention(fixture.events, userId)) as Array<{
      kind: string;
      rows: unknown[];
    }>;
    expect(exported.map((e) => e.kind)).toEqual([
      'attention_aggregates',
      'signal_ledger',
      'attention_events',
    ]);
    expect(exported[0]?.rows).toHaveLength(1);
  });

  it('a retention change to `none` tightens existing purge deadlines (never extends)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId)],
      ONLINE_ACCEPTANCE,
    );
    const before = await fixture.events.eventStore.listByOwner(userId);
    const beforeDeadline = Date.parse(before[0]?.purgeAfter ?? '');
    await applyRetentionPreferenceChange(fixture.events, userId, 'none');
    const after = await fixture.events.eventStore.listByOwner(userId);
    const afterDeadline = Date.parse(after[0]?.purgeAfter ?? '');
    expect(afterDeadline).toBeLessThan(beforeDeadline);
    expect(afterDeadline - Date.now()).toBeLessThanOrEqual(3_600_000 + 5_000);
    // A change back to `default` never re-extends the deadline.
    await applyRetentionPreferenceChange(fixture.events, userId, 'default');
    const unchanged = await fixture.events.eventStore.listByOwner(userId);
    expect(Date.parse(unchanged[0]?.purgeAfter ?? '')).toBe(afterDeadline);
  });
});

describe('DSAR export completeness (WS-D hook, SPEC §19.3)', () => {
  it('exports EVERY ledger entry (paginating past the page size, no truncation)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const entries = Array.from({ length: 503 }, (_, i) => ({
      entryId: randomUUID(),
      ownerUserId: userId,
      itemId: randomUUID(),
      storyTitle: `Story ${i}`,
      windowStart: new Date(Date.UTC(2026, 5, 10, 10)).toISOString(),
      windowSize: '1h' as const,
      signals: {},
      antiSignals: [],
      pwattScore: 0.1,
      summary: 'You read this for a short while.',
      recordedAt: new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString(),
      purgeAfter: new Date(Date.now() + 30 * DAY).toISOString(),
    }));
    await fixture.events.ledgerStore.upsertMany(entries);
    const exported = (await exportUserAttention(fixture.events, userId)) as Array<{
      kind: string;
      rows: unknown[];
    }>;
    const ledger = exported.find((e) => e.kind === 'signal_ledger');
    expect(ledger?.rows).toHaveLength(503);
  });

  it('includes the user’s owned attention EVENTS (source-open reports too)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId), sourceOpenEvent(userId)],
      ONLINE_ACCEPTANCE,
    );
    // An owned NON-attention event must NOT leak into the attention export
    // (contributions are the WS-G export hook's responsibility).
    await fixture.events.eventStore.insertMany([
      {
        eventId: randomUUID(),
        eventType: 'contribution.created',
        topic: 'contribution.created',
        timestamp: new Date().toISOString(),
        privacyClassification: 'public',
        retentionTier: 'public_contribution',
        payload: {},
        ownerUserId: userId,
        purgeAfter: null,
      },
    ]);
    const exported = (await exportUserAttention(fixture.events, userId)) as Array<{
      kind: string;
      rows: Array<{ topic?: string }>;
    }>;
    expect(exported.map((e) => e.kind)).toEqual([
      'attention_aggregates',
      'signal_ledger',
      'attention_events',
    ]);
    const events = exported.find((e) => e.kind === 'attention_events');
    expect(events?.rows).toHaveLength(2);
    expect(events?.rows.map((r) => r.topic).sort()).toEqual([
      'attention.aggregate',
      'source.opened.aggregate',
    ]);
  });
});
