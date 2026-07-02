// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-E.1.1g/f/1.2 acceptance: registry completeness against the hardcoded SPEC
// §21.3 topic lists, round-trip parse per topic, unknown-event_type rejection,
// per-topic classification/tier consistency between registry and schema
// literals, retention-tier coverage, the documented §22.1 field-name mapping,
// and the Knomosis bounded-context field discipline (SPEC §19.5).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ALL_EVENT_TOPICS,
  attentionAggregateItemSchema,
  CORE_TOPICS,
  type EventTopic,
  getRetentionDays,
  isKnomosisTopic,
  isRegisteredTopic,
  licioEventSchema,
  PRIVACY_CLASSIFICATIONS,
  parseEvent,
  RETENTION_TIERS,
  TOPIC_REGISTRY,
} from '../index.js';
import { KNOMOSIS_EVENT_SCHEMAS, KNOMOSIS_TOPICS } from '../schemas/events/knomosis/index.js';
import { EVENT_FIXTURES } from './event-fixtures.js';

/** SPEC §21.3 core topics, hardcoded from the SPEC text (drift detector). */
const SPEC_21_3_CORE_TOPICS = [
  'content.submitted',
  'content.normalized',
  'content.visibility.changed',
  'source.opened.aggregate',
  'content.saved',
  'attention.aggregate',
  'contribution.created',
  'evidence.added',
  'claim.updated',
  'thread.state.changed',
  'moderation.case.created',
  'integrity.signal.detected',
  'invariant.run.completed',
  'ranking.decision.logged',
  'notification.sent',
  'privacy.request.created',
] as const;

/** SPEC §21.3 Knomosis topics, hardcoded from the SPEC text (drift detector). */
const SPEC_21_3_KNOMOSIS_TOPICS = [
  'wallet.link.requested',
  'wallet.linked',
  'payment.intent.created',
  'payment.intent.failed',
  'payment.receipt.indexed',
  'room.governance.mode.changed',
  'governance.proposal.created',
  'governance.signature.recorded',
  'governance.proposal.executed',
  'governance.proposal.challenged',
  'treasury.deposit.indexed',
  'treasury.grant.approved',
  'treasury.payout.executed',
  'knomosis.action.preflighted',
  'knomosis.action.submitted',
  'knomosis.event.indexed',
  'compliance.financial.case.created',
  'jurisdiction.feature.disabled',
] as const;

describe('topic registry completeness (WS-E.1.1g)', () => {
  it('registers every SPEC §21.3 core topic', () => {
    for (const topic of SPEC_21_3_CORE_TOPICS) {
      expect(isRegisteredTopic(topic), `missing core topic ${topic}`).toBe(true);
      expect(TOPIC_REGISTRY[topic as EventTopic].knomosis).toBe(false);
    }
    expect([...CORE_TOPICS].sort()).toEqual([...SPEC_21_3_CORE_TOPICS].sort());
  });

  it('registers every SPEC §21.3 Knomosis topic with knomosis: true (WS-E.1.2)', () => {
    expect(SPEC_21_3_KNOMOSIS_TOPICS).toHaveLength(18);
    for (const topic of SPEC_21_3_KNOMOSIS_TOPICS) {
      expect(isRegisteredTopic(topic), `missing Knomosis topic ${topic}`).toBe(true);
      expect(TOPIC_REGISTRY[topic as EventTopic].knomosis).toBe(true);
      expect(isKnomosisTopic(topic)).toBe(true);
    }
    expect([...KNOMOSIS_TOPICS].sort()).toEqual([...SPEC_21_3_KNOMOSIS_TOPICS].sort());
  });

  it('every registered topic has a non-null classification, tier, and version', () => {
    for (const topic of ALL_EVENT_TOPICS) {
      const entry = TOPIC_REGISTRY[topic];
      expect(PRIVACY_CLASSIFICATIONS).toContain(entry.privacy_classification);
      expect(RETENTION_TIERS).toContain(entry.retention_tier);
      expect(entry.since_version).toBe('1');
      // Every tier referenced by the registry has a configured window (WS-E.1.1f).
      const window = getRetentionDays(entry.retention_tier);
      expect(window.min).toBeGreaterThanOrEqual(0);
      expect(window.max).toBeGreaterThanOrEqual(window.min);
      expect(window.policy.length).toBeGreaterThan(0);
    }
  });

  it('has a fixture for every topic and a topic for every fixture', () => {
    expect(Object.keys(EVENT_FIXTURES).sort()).toEqual([...ALL_EVENT_TOPICS].sort());
  });
});

describe('discriminated union + parseEvent (WS-E.1.1g)', () => {
  it('round-trips one valid event per topic and matches the registry metadata', () => {
    for (const topic of ALL_EVENT_TOPICS) {
      const fixture = EVENT_FIXTURES[topic];
      const viaUnion = licioEventSchema.parse(fixture);
      expect(viaUnion).toEqual(fixture);
      const viaRegistry = parseEvent(fixture);
      expect(viaRegistry.ok, `parseEvent failed for ${topic}`).toBe(true);
      if (viaRegistry.ok) {
        // The schema literals must agree with the registry entry — no drift.
        expect(viaRegistry.event.privacy_classification).toBe(
          TOPIC_REGISTRY[topic].privacy_classification,
        );
        expect(viaRegistry.event.retention_tier).toBe(TOPIC_REGISTRY[topic].retention_tier);
        expect(viaRegistry.event.event_type).toBe(topic);
      }
    }
  });

  it('rejects unknown event_type values', () => {
    const forged = { ...EVENT_FIXTURES['attention.aggregate'], event_type: 'attention.raw' };
    expect(licioEventSchema.safeParse(forged).success).toBe(false);
    const result = parseEvent(forged);
    expect(result).toMatchObject({ ok: false, reason: 'unknown_topic' });
  });

  it('rejects an event with a missing envelope field', () => {
    const { timestamp: _dropped, ...rest } = EVENT_FIXTURES['contribution.created'];
    expect(parseEvent(rest)).toMatchObject({ ok: false, reason: 'invalid_envelope' });
  });

  it('rejects a misclassified event (classification literal mismatch)', () => {
    const misclassified = {
      ...EVENT_FIXTURES['attention.aggregate'],
      privacy_classification: 'public',
    };
    expect(parseEvent(misclassified)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });
});

describe('AttentionAggregate field-name mapping (WS-E.1.1g / SPEC §22.1)', () => {
  it('the per-item summary carries exactly the §22.1 per-item field names', () => {
    expect(Object.keys(attentionAggregateItemSchema.shape).sort()).toEqual(
      [
        'story_id',
        'active_dwell_bucket',
        'source_opened',
        'context_opened',
        'reply_depth_bucket',
        'return_visit_count_bucket',
      ].sort(),
    );
  });

  it('attention topics are classified `aggregated` with the attention tier', () => {
    for (const topic of ['attention.aggregate', 'source.opened.aggregate'] as const) {
      expect(TOPIC_REGISTRY[topic].privacy_classification).toBe('aggregated');
      expect(TOPIC_REGISTRY[topic].retention_tier).toBe('attention_aggregated');
    }
  });
});

describe('Knomosis bounded-context field discipline (WS-E.1.2 / SPEC §19.5)', () => {
  /** Field-name fragments that would indicate attention/reading/report history. */
  const FORBIDDEN_FRAGMENTS = ['dwell', 'attention', 'bucket', 'report', 'reading', 'scroll'];

  function shapeKeys(schema: unknown): string[] {
    if (schema instanceof z.ZodObject) return Object.keys(schema.shape);
    throw new Error('expected a ZodObject schema');
  }

  it('no Knomosis schema carries an attention/reading/report-history field', () => {
    for (const topic of KNOMOSIS_TOPICS) {
      for (const key of shapeKeys(KNOMOSIS_EVENT_SCHEMAS[topic])) {
        for (const fragment of FORBIDDEN_FRAGMENTS) {
          expect(key.toLowerCase().includes(fragment), `${topic}.${key} ~ ${fragment}`).toBe(false);
        }
      }
    }
  });

  it('wallet/payment/treasury/compliance topics are restricted; governance/indexing sensitive', () => {
    const restricted = KNOMOSIS_TOPICS.filter(
      (t) => TOPIC_REGISTRY[t].privacy_classification === 'restricted',
    );
    const sensitive = KNOMOSIS_TOPICS.filter(
      (t) => TOPIC_REGISTRY[t].privacy_classification === 'sensitive',
    );
    expect(restricted.length + sensitive.length).toBe(18);
    for (const t of restricted) {
      expect(t).toMatch(/^(wallet|payment|treasury|compliance)\./);
    }
    for (const t of sensitive) {
      expect(t).toMatch(/^(room\.governance|governance|knomosis|jurisdiction)\./);
    }
  });

  it('monetary amounts are integer strings in minor units (never floats)', () => {
    const intent = {
      ...EVENT_FIXTURES['payment.intent.created'],
      amount: 25.5,
    };
    expect(parseEvent(intent).ok).toBe(false);
    const negative = { ...EVENT_FIXTURES['payment.intent.created'], amount: '-5' };
    expect(parseEvent(negative).ok).toBe(false);
  });
});

describe('retention tiers (WS-E.1.1f)', () => {
  it('every tier has a configured window with min <= max', () => {
    for (const tier of RETENTION_TIERS) {
      const window = getRetentionDays(tier);
      expect(window.min).toBeGreaterThanOrEqual(0);
      expect(window.max).toBeGreaterThanOrEqual(window.min);
      expect(window.policy.length).toBeGreaterThan(0);
    }
  });

  it('matches the SPEC §22.4 defaults for the clock-bounded tiers', () => {
    expect(getRetentionDays('attention_raw')).toMatchObject({ min: 0, max: 7 });
    expect(getRetentionDays('attention_aggregated')).toMatchObject({ min: 90, max: 180 });
    expect(getRetentionDays('ranking_log')).toMatchObject({ min: 180, max: 365 });
    expect(getRetentionDays('moderation_legal').max).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('client-suppliable topics share one retention tier (WS-E.1.3b backstop)', () => {
  it('both attention-ingestion topics map to attention_aggregated', () => {
    // The durable replay backstop dedups on event_id; the partitioned PK is
    // (event_id, retention_tier). With both client-suppliable topics pinned to
    // ONE tier, a client can never place the same event_id in two partitions —
    // the PK alone already rejects the cross-topic replay at the storage layer.
    expect(TOPIC_REGISTRY['attention.aggregate'].retention_tier).toBe('attention_aggregated');
    expect(TOPIC_REGISTRY['source.opened.aggregate'].retention_tier).toBe('attention_aggregated');
  });
});
