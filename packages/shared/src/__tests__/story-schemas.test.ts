// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.1b / WS-F.1.4b — story zod contracts: per-type discriminated-union
// validation, field bounds, BCP 47 acceptance/rejection, sensitivity-label
// subset enforcement, unknown-key rejection, and the StoryPublic projection.
import { describe, expect, it } from 'vitest';
import {
  bcp47Schema,
  canonicalizeBcp47,
  locationScopeSchema,
  storyCreateRequestSchema,
  storyCreateResponseSchema,
  storyDuplicateResponseSchema,
  storyPublicSchema,
  submissionMetadataSchema,
} from '../schemas/story.js';

// Deterministic UUID literals (shared tests carry no node:crypto dependency —
// this package compiles environment-neutral, the house fixture pattern).
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let uuidCounter = 0;
const randomUUID = (): string => {
  uuidCounter += 1;
  return uuidOf(uuidCounter);
};

const TOPIC = randomUUID();

function linkBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submission_type: 'link',
    url: 'https://example.com/article',
    reason: 'Primary source on the new policy',
    title: 'Example article',
    topic_ids: [TOPIC],
    ...overrides,
  };
}

describe('bcp47Schema (WS-F.1.1b)', () => {
  it.each([
    'en',
    'pt-BR',
    'zh-Hans',
    'sr-Latn-RS',
    'es-419',
    'de-CH-1996',
    'und',
  ])('accepts %s', (tag) => {
    expect(bcp47Schema.safeParse(tag).success).toBe(true);
  });

  it.each([
    'english',
    'en_US',
    'e',
    '1234',
    '-en',
    'en-',
    'en--US',
    'a'.repeat(40),
  ])('rejects %s', (tag) => {
    expect(bcp47Schema.safeParse(tag).success).toBe(false);
  });

  it('canonicalizes conventional casing (language lower, script Title, region UPPER)', () => {
    expect(canonicalizeBcp47('PT-br')).toBe('pt-BR');
    expect(canonicalizeBcp47('ZH-HANS')).toBe('zh-Hans');
    expect(canonicalizeBcp47('sr-latn-rs')).toBe('sr-Latn-RS');
  });
});

describe('storyCreateRequestSchema — shared bounds', () => {
  it('accepts a valid link submission', () => {
    expect(storyCreateRequestSchema.safeParse(linkBody()).success).toBe(true);
  });

  it('rejects an empty title and an over-length title', () => {
    expect(storyCreateRequestSchema.safeParse(linkBody({ title: '' })).success).toBe(false);
    expect(storyCreateRequestSchema.safeParse(linkBody({ title: 'x'.repeat(301) })).success).toBe(
      false,
    );
  });

  it('rejects empty topic_ids and non-UUID topics', () => {
    expect(storyCreateRequestSchema.safeParse(linkBody({ topic_ids: [] })).success).toBe(false);
    expect(storyCreateRequestSchema.safeParse(linkBody({ topic_ids: ['politics'] })).success).toBe(
      false,
    );
  });

  it('rejects invalid BCP 47 tags and unknown sensitivity labels', () => {
    expect(storyCreateRequestSchema.safeParse(linkBody({ language: 'english' })).success).toBe(
      false,
    );
    expect(
      storyCreateRequestSchema.safeParse(linkBody({ sensitivity_labels: ['nsfw'] })).success,
    ).toBe(false);
    expect(
      storyCreateRequestSchema.safeParse(
        linkBody({ language: 'pt-BR', sensitivity_labels: ['graphic', 'crisis'] }),
      ).success,
    ).toBe(true);
  });

  it('rejects unknown keys (strict parsing on every member)', () => {
    expect(storyCreateRequestSchema.safeParse(linkBody({ wallet_address: '0xabc' })).success).toBe(
      false,
    );
  });
});

describe('storyCreateRequestSchema — per-type requirements (WS-F.1.4b)', () => {
  it('link requires a URL; other types reject a URL field', () => {
    const { url: _url, ...withoutUrl } = linkBody();
    expect(storyCreateRequestSchema.safeParse(withoutUrl).success).toBe(false);
    const question = {
      submission_type: 'question',
      question: 'What changed in the final bill?',
      title: 'Final bill changes',
      topic_ids: [TOPIC],
      url: 'https://example.com/x',
    };
    expect(storyCreateRequestSchema.safeParse(question).success).toBe(false);
  });

  it('original_brief requires a body and accepts the experience disclosure', () => {
    const base = {
      submission_type: 'original_brief',
      title: 'What I saw at the council meeting',
      topic_ids: [TOPIC],
    };
    expect(storyCreateRequestSchema.safeParse(base).success).toBe(false);
    expect(
      storyCreateRequestSchema.safeParse({
        ...base,
        body: 'Detailed first-hand notes…',
        personal_experience_disclosure: true,
      }).success,
    ).toBe(true);
  });

  it('evidence_card requires a claim reference and names the missing field', () => {
    const noClaim = {
      submission_type: 'evidence_card',
      citation_url_or_ref: 'https://example.com/study',
      relevance_note: 'Replicates the headline finding',
      title: 'Replication study',
      topic_ids: [TOPIC],
    };
    const result = storyCreateRequestSchema.safeParse(noClaim);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('claim_id'))).toBe(true);
    }
    expect(storyCreateRequestSchema.safeParse({ ...noClaim, claim_id: randomUUID() }).success).toBe(
      true,
    );
  });

  it('local_update requires a location scope', () => {
    const noScope = {
      submission_type: 'local_update',
      source_or_experience_disclosure: 'I live two blocks away',
      title: 'Bridge closure update',
      topic_ids: [TOPIC],
    };
    const result = storyCreateRequestSchema.safeParse(noScope);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('location_scope'))).toBe(true);
    }
    expect(
      storyCreateRequestSchema.safeParse({
        ...noScope,
        location_scope: { type: 'city', value: 'Lisbon' },
      }).success,
    ).toBe(true);
  });

  it('live_thread requires event, time reference, and a moderation mode', () => {
    const base = {
      submission_type: 'live_thread',
      event_description: 'Election night count',
      title: 'Election night live',
      topic_ids: [TOPIC],
    };
    expect(storyCreateRequestSchema.safeParse(base).success).toBe(false);
    expect(
      storyCreateRequestSchema.safeParse({
        ...base,
        time_reference: '2026-06-11T20:00:00Z onwards',
        moderation_mode: 'breaking',
      }).success,
    ).toBe(true);
    expect(
      storyCreateRequestSchema.safeParse({
        ...base,
        time_reference: 'tonight',
        moderation_mode: 'unmoderated',
      }).success,
    ).toBe(false);
  });
});

describe('submissionMetadataSchema (stored JSONB shape)', () => {
  it('round-trips each member type and rejects unknown keys', () => {
    const link = { submission_type: 'link', url: 'https://example.com/a', reason: 'source' };
    expect(submissionMetadataSchema.parse(link)).toEqual(link);
    expect(submissionMetadataSchema.safeParse({ ...link, tracking_pixel: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown submission_type', () => {
    expect(
      submissionMetadataSchema.safeParse({ submission_type: 'advert', body: 'buy now' }).success,
    ).toBe(false);
  });
});

describe('locationScopeSchema', () => {
  it('accepts the structured shape and rejects free-form objects', () => {
    expect(locationScopeSchema.safeParse({ type: 'country', value: 'PT' }).success).toBe(true);
    expect(locationScopeSchema.safeParse({ type: 'global', value: 'global' }).success).toBe(true);
    expect(locationScopeSchema.safeParse({ type: 'planet', value: 'earth' }).success).toBe(false);
    expect(
      locationScopeSchema.safeParse({ type: 'city', value: 'Lisbon', lat: 38.7 }).success,
    ).toBe(false);
  });
});

describe('storyPublicSchema + responses (WS-F.1.1b)', () => {
  const story = {
    story_id: randomUUID(),
    title: 'Example',
    submission_type: 'link' as const,
    canonical_url: 'https://example.com/a',
    source_id: randomUUID(),
    submitted_by: randomUUID(),
    language: 'en',
    topic_ids: [TOPIC],
    location_scope: null,
    sensitivity_labels: ['none' as const],
    lifecycle_state: 'submitted' as const,
    thread_id: randomUUID(),
    excerpt: 'A bounded excerpt…',
    publisher: 'Example News',
    author: 'A. Reporter',
    published_at: new Date().toISOString(),
    media_type: 'article' as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it('accepts the full public projection', () => {
    expect(storyPublicSchema.parse(story)).toEqual(story);
  });

  it('rejects internal-only fields (no leakage path)', () => {
    for (const internal of ['extraction_diagnostics', 'review_state', 'minhash', 'hidden_state']) {
      expect(storyPublicSchema.safeParse({ ...story, [internal]: 'x' }).success).toBe(false);
    }
  });

  it('validates the create + duplicate response envelopes', () => {
    expect(
      storyCreateResponseSchema.safeParse({
        story,
        story_id: story.story_id,
        thread_id: story.thread_id,
        lifecycle_state: 'submitted',
        similar_story_ids: [],
        review_flags: [],
      }).success,
    ).toBe(true);
    expect(
      storyDuplicateResponseSchema.safeParse({
        error: { code: 'duplicate_story', message: 'already submitted' },
        existing_story_id: story.story_id,
      }).success,
    ).toBe(true);
  });
});
