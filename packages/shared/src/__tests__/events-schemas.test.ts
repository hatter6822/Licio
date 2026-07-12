// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-topic schema acceptance tests (WS-E.1.1a-e). The attention suite is the
// privacy-critical one: it asserts the schema CANNOT be widened to accept a
// numeric dwell, that unknown keys are always rejected (deterministic fuzz),
// and that no field can carry raw scroll/touch traces (SPEC §19.2).
import { describe, expect, it } from 'vitest';
import {
  attentionAggregateEventSchema,
  CLAIM_STATUSES,
  claimUpdatedEventSchema,
  contentSubmittedEventSchema,
  contributionCreatedEventSchema,
  EVENT_CONTRIBUTION_TYPES,
  INTEGRITY_SIGNAL_TYPES,
  integritySignalDetectedEventSchema,
  isLegalClaimTransition,
  MODERATION_CATEGORY_IDS,
  MODERATION_REASON_CODES,
  moderationCaseCreatedEventSchema,
  moderationReasonCodeSchema,
  SUBMISSION_TYPES,
  sourceOpenedAggregateEventSchema,
} from '../index.js';
import { EVENT_FIXTURES } from './event-fixtures.js';

/** Deterministic PRNG (mulberry32) so the fuzz suite is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('content events (WS-E.1.1a)', () => {
  it('parses a valid content.submitted and rejects unknown keys', () => {
    expect(contentSubmittedEventSchema.parse(EVENT_FIXTURES['content.submitted'])).toEqual(
      EVENT_FIXTURES['content.submitted'],
    );
    expect(
      contentSubmittedEventSchema.safeParse({
        ...EVENT_FIXTURES['content.submitted'],
        browsing_history: ['https://evil.example'],
      }).success,
    ).toBe(false);
  });

  it('rejects missing fields and wrong types', () => {
    const { story_id: _dropped, ...missing } = EVENT_FIXTURES['content.submitted'];
    expect(contentSubmittedEventSchema.safeParse(missing).success).toBe(false);
    expect(
      contentSubmittedEventSchema.safeParse({
        ...EVENT_FIXTURES['content.submitted'],
        topic_ids: 'water',
      }).success,
    ).toBe(false);
  });

  it('submission_type enum is exhaustive per SPEC §14.1 (+ WS-Q media)', () => {
    expect([...SUBMISSION_TYPES].sort()).toEqual(
      ['link', 'original_brief', 'image_post', 'video_post'].sort(),
    );
    for (const submissionType of SUBMISSION_TYPES) {
      expect(
        contentSubmittedEventSchema.safeParse({
          ...EVENT_FIXTURES['content.submitted'],
          submission_type: submissionType,
        }).success,
      ).toBe(true);
    }
    // The retired write-taxonomy discriminators must be structurally rejected.
    for (const retired of ['question', 'local_update', 'live_thread']) {
      expect(
        contentSubmittedEventSchema.safeParse({
          ...EVENT_FIXTURES['content.submitted'],
          submission_type: retired,
        }).success,
        `retired submission_type ${retired} must be rejected`,
      ).toBe(false);
    }
  });

  it('WS-Q.1.7c — classification TRACKS visibility (public⟺public, room_only⟺restricted)', () => {
    // public visibility must carry the public classification (the fixture).
    expect(
      contentSubmittedEventSchema.safeParse({
        ...EVENT_FIXTURES['content.submitted'],
        visibility: 'public',
        privacy_classification: 'public',
      }).success,
    ).toBe(true);
    // room_only visibility REQUIRES the restricted first-party classification.
    expect(
      contentSubmittedEventSchema.safeParse({
        ...EVENT_FIXTURES['content.submitted'],
        visibility: 'room_only',
        privacy_classification: 'restricted',
      }).success,
    ).toBe(true);
    // A room_only event labeled `public` is structurally rejected — a buggy
    // emitter cannot leak in-room content onto a public consumer path.
    expect(
      contentSubmittedEventSchema.safeParse({
        ...EVENT_FIXTURES['content.submitted'],
        visibility: 'room_only',
        privacy_classification: 'public',
      }).success,
    ).toBe(false);
    // Likewise a public event labeled restricted is rejected (coupling is iff).
    expect(
      contentSubmittedEventSchema.safeParse({
        ...EVENT_FIXTURES['content.submitted'],
        visibility: 'public',
        privacy_classification: 'restricted',
      }).success,
    ).toBe(false);
  });

  it('WS-Q.1.7c — content events require room_id', () => {
    const { room_id: _r, ...noRoom } = EVENT_FIXTURES['content.submitted'];
    expect(contentSubmittedEventSchema.safeParse(noRoom).success).toBe(false);
  });

  it('rejects a javascript: canonical_url (XSS defense in the URL schema)', () => {
    expect(
      contentSubmittedEventSchema.safeParse({
        ...EVENT_FIXTURES['content.submitted'],
        // eslint-disable-next-line no-script-url -- the rejected fixture
        canonical_url: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
  });
});

describe('attention events (WS-E.1.1b) — the privacy-critical schema', () => {
  it('parses a valid attention.aggregate event', () => {
    expect(attentionAggregateEventSchema.parse(EVENT_FIXTURES['attention.aggregate'])).toEqual(
      EVENT_FIXTURES['attention.aggregate'],
    );
  });

  it('cannot be widened to accept a numeric dwell (raw value rejection)', () => {
    const fixture = EVENT_FIXTURES['attention.aggregate'] as {
      items: Array<Record<string, unknown>>;
    };
    const rawDwell = {
      ...EVENT_FIXTURES['attention.aggregate'],
      items: [{ ...fixture.items[0], active_dwell_bucket: 145_000 }],
    };
    expect(attentionAggregateEventSchema.safeParse(rawDwell).success).toBe(false);
    const rawReturn = {
      ...EVENT_FIXTURES['attention.aggregate'],
      items: [{ ...fixture.items[0], return_visit_count_bucket: 7 }],
    };
    expect(attentionAggregateEventSchema.safeParse(rawReturn).success).toBe(false);
  });

  it('rejects raw-trace fields at both the event and item level', () => {
    const fixture = EVENT_FIXTURES['attention.aggregate'] as {
      items: Array<Record<string, unknown>>;
    };
    for (const rawKey of ['scrollY', 'clientX', 'dwell_ms', 'touches', 'rawEvents']) {
      expect(
        attentionAggregateEventSchema.safeParse({
          ...EVENT_FIXTURES['attention.aggregate'],
          [rawKey]: 123,
        }).success,
        `event-level ${rawKey} must be rejected`,
      ).toBe(false);
      expect(
        attentionAggregateEventSchema.safeParse({
          ...EVENT_FIXTURES['attention.aggregate'],
          items: [{ ...fixture.items[0], [rawKey]: 123 }],
        }).success,
        `item-level ${rawKey} must be rejected`,
      ).toBe(false);
    }
  });

  it('fuzz: random extra keys are always rejected (200 deterministic cases)', () => {
    const random = mulberry32(0x5eed);
    const fixture = EVENT_FIXTURES['attention.aggregate'] as {
      items: Array<Record<string, unknown>>;
    };
    for (let i = 0; i < 200; i += 1) {
      const key = `k${Math.floor(random() * 1e9).toString(36)}`;
      const value = random() < 0.5 ? Math.floor(random() * 1e6) : `v${i}`;
      const atItem = random() < 0.5;
      const candidate = atItem
        ? {
            ...EVENT_FIXTURES['attention.aggregate'],
            items: [{ ...fixture.items[0], [key]: value }],
          }
        : { ...EVENT_FIXTURES['attention.aggregate'], [key]: value };
      expect(
        attentionAggregateEventSchema.safeParse(candidate).success,
        `extra key ${key} (${atItem ? 'item' : 'event'}) must be rejected`,
      ).toBe(false);
    }
  });

  it('bounce is a boolean, never a duration; source ids are in-app UUIDs only', () => {
    expect(
      sourceOpenedAggregateEventSchema.parse(EVENT_FIXTURES['source.opened.aggregate']),
    ).toEqual(EVENT_FIXTURES['source.opened.aggregate']);
    expect(
      sourceOpenedAggregateEventSchema.safeParse({
        ...EVENT_FIXTURES['source.opened.aggregate'],
        bounce: 1500,
      }).success,
    ).toBe(false);
    // An arbitrary external URL is structurally rejected (SPEC §19.2: no
    // off-app browsing history).
    expect(
      sourceOpenedAggregateEventSchema.safeParse({
        ...EVENT_FIXTURES['source.opened.aggregate'],
        source_id: 'https://tracker.example/path?q=1',
      }).success,
    ).toBe(false);
  });

  it('requires the aggregated classification and attention tier literals', () => {
    expect(
      attentionAggregateEventSchema.safeParse({
        ...EVENT_FIXTURES['attention.aggregate'],
        retention_tier: 'security_log',
      }).success,
    ).toBe(false);
  });
});

describe('contribution events (WS-E.1.1c)', () => {
  it('parses each contribution type; low_info_reply is present for anti-signals', () => {
    // The post-retirement event taxonomy is exactly the five live types.
    expect([...EVENT_CONTRIBUTION_TYPES].sort()).toEqual(
      ['correction', 'explanation', 'bridge_comment', 'steward_action', 'low_info_reply'].sort(),
    );
    expect(EVENT_CONTRIBUTION_TYPES).toContain('low_info_reply');
    expect(EVENT_CONTRIBUTION_TYPES).toContain('bridge_comment');
    expect(EVENT_CONTRIBUTION_TYPES).toContain('steward_action');
    for (const contributionType of EVENT_CONTRIBUTION_TYPES) {
      expect(
        contributionCreatedEventSchema.safeParse({
          ...EVENT_FIXTURES['contribution.created'],
          contribution_type: contributionType,
        }).success,
      ).toBe(true);
    }
  });

  it('validates claim status transitions and rejects illegal ones', () => {
    // retracted is terminal; nothing returns to unverified.
    expect(isLegalClaimTransition('unverified', 'supported')).toBe(true);
    expect(isLegalClaimTransition('challenged', 'corrected')).toBe(true);
    expect(isLegalClaimTransition('retracted', 'unverified')).toBe(false);
    expect(isLegalClaimTransition('supported', 'unverified')).toBe(false);
    for (const status of CLAIM_STATUSES) {
      expect(isLegalClaimTransition('retracted', status)).toBe(false);
      expect(isLegalClaimTransition(status, status)).toBe(false);
    }
    expect(
      claimUpdatedEventSchema.safeParse({
        ...EVENT_FIXTURES['claim.updated'],
        old_status: 'retracted',
        new_status: 'unverified',
      }).success,
    ).toBe(false);
    expect(
      claimUpdatedEventSchema.safeParse({
        ...EVENT_FIXTURES['claim.updated'],
        old_status: 'challenged',
        new_status: 'supported',
      }).success,
    ).toBe(true);
  });
});

describe('moderation events (WS-E.1.1d)', () => {
  it('is restricted with the moderation_legal tier', () => {
    const parsed = moderationCaseCreatedEventSchema.parse(
      EVENT_FIXTURES['moderation.case.created'],
    );
    expect(parsed.privacy_classification).toBe('restricted');
    expect(parsed.retention_tier).toBe('moderation_legal');
  });

  it('accepts reason codes from every SPEC §18.1 category and rejects others', () => {
    expect(MODERATION_CATEGORY_IDS).toHaveLength(12);
    for (const category of MODERATION_CATEGORY_IDS) {
      expect(moderationReasonCodeSchema.safeParse(`${category}_001`).success).toBe(true);
    }
    // The crypto-abuse plane (MOD_CRYPTO_<MODE>_NNN) is accepted alongside.
    expect(moderationReasonCodeSchema.safeParse('MOD_CRYPTO_DRAIN_001').success).toBe(true);
    expect(moderationReasonCodeSchema.safeParse('MOD_BOGUS_001').success).toBe(false);
    expect(moderationReasonCodeSchema.safeParse('SPAM_001').success).toBe(false);
    expect(moderationReasonCodeSchema.safeParse('MOD_HARASS').success).toBe(false); // no suffix
    expect(moderationReasonCodeSchema.safeParse('mod_harass_001').success).toBe(false); // lowercase
  });

  it('every ratified report reason code parses through the case-created event schema', () => {
    // No-drift: the report request accepts the full WS-A taxonomy, and
    // submitReport forwards the code into `moderation.case.created`.  A code that
    // the event schema rejects would save the case/report but silently drop the
    // durable intake event, so every ratified code MUST parse here.
    for (const code of MODERATION_REASON_CODES) {
      expect(moderationReasonCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('integrity signal types match the SPEC §5.3 anti-signal set', () => {
    expect([...INTEGRITY_SIGNAL_TYPES].sort()).toEqual(
      [
        'coordinated_burst',
        'rage_loop',
        'source_free_accusation',
        'brigading',
        'harassment_cascade',
      ].sort(),
    );
    const parsed = integritySignalDetectedEventSchema.parse(
      EVENT_FIXTURES['integrity.signal.detected'],
    );
    expect(parsed.confidence).toBeGreaterThanOrEqual(0);
    expect(parsed.confidence).toBeLessThanOrEqual(1);
  });

  it('reporter_id may be null for automated detection', () => {
    expect(
      moderationCaseCreatedEventSchema.safeParse({
        ...EVENT_FIXTURES['moderation.case.created'],
        reporter_id: null,
        source: 'automated',
      }).success,
    ).toBe(true);
  });
});
