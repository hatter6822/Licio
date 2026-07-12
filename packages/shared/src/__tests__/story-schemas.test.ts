// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.1b / WS-F.1.4b — story zod contracts: per-type discriminated-union
// validation, field bounds, BCP 47 acceptance/rejection, sensitivity-label
// subset enforcement, unknown-key rejection, and the StoryPublic projection.
import { describe, expect, it } from 'vitest';
import { topicIdForSlug } from '../constants/topics.js';
import {
  bcp47Schema,
  canonicalizeBcp47,
  deriveStoryVisibility,
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

// A real, selectable catalog topic (author proposals must be catalog topics).
const TOPIC = topicIdForSlug('local-community');
const ROOM = randomUUID();

function linkBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submission_type: 'link',
    url: 'https://example.com/article',
    reason: 'Primary source on the new policy',
    title: 'Example article',
    topic_ids: [TOPIC],
    room_id: ROOM,
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

  it('rejects empty topic_ids and non-catalog topics (author proposals must be catalog topics)', () => {
    expect(storyCreateRequestSchema.safeParse(linkBody({ topic_ids: [] })).success).toBe(false);
    // Non-UUID string is rejected.
    expect(storyCreateRequestSchema.safeParse(linkBody({ topic_ids: ['politics'] })).success).toBe(
      false,
    );
    // A valid UUID that is NOT in the catalog is also rejected (catalog membership,
    // not just shape — an author can only PROPOSE a real, selectable topic).
    expect(
      storyCreateRequestSchema.safeParse(linkBody({ topic_ids: [randomUUID()] })).success,
    ).toBe(false);
    // The UNCLASSIFIED sentinel is never author-selectable.
    expect(
      storyCreateRequestSchema.safeParse(
        linkBody({ topic_ids: ['70b1c0de-0000-4000-8000-000000000000'] }),
      ).success,
    ).toBe(false);
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
    const briefWithUrl = {
      submission_type: 'original_brief',
      body: 'Detailed first-hand notes…',
      title: 'What I saw at the council meeting',
      topic_ids: [TOPIC],
      room_id: ROOM,
      url: 'https://example.com/x',
    };
    expect(storyCreateRequestSchema.safeParse(briefWithUrl).success).toBe(false);
  });

  it('original_brief requires a body and accepts the experience disclosure', () => {
    const base = {
      submission_type: 'original_brief',
      title: 'What I saw at the council meeting',
      topic_ids: [TOPIC],
      room_id: ROOM,
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

  it('rejects the removed evidence_card submission type', () => {
    // The EvidenceCard entity was removed with its orphaned creation paths;
    // the discriminated union must not accept the retired discriminator.
    expect(
      storyCreateRequestSchema.safeParse({
        submission_type: 'evidence_card',
        citation_url_or_ref: 'https://example.com/study',
        claim_id: randomUUID(),
        relevance_note: 'Replicates the headline finding',
        title: 'Replication study',
        topic_ids: [TOPIC],
        room_id: ROOM,
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'question',
      {
        submission_type: 'question',
        question: 'What changed in the final bill?',
        title: 'Final bill changes',
      },
    ],
    [
      'local_update',
      {
        submission_type: 'local_update',
        source_or_experience_disclosure: 'I live two blocks away',
        location_scope: { type: 'city', value: 'Lisbon' },
        title: 'Bridge closure update',
      },
    ],
    [
      'live_thread',
      {
        submission_type: 'live_thread',
        event_description: 'Election night count',
        time_reference: '2026-06-11T20:00:00Z onwards',
        moderation_mode: 'breaking',
        title: 'Election night live',
      },
    ],
  ])('rejects the retired %s submission type outright', (_t, payload) => {
    // The legacy write taxonomy is retired: the discriminated union carries no
    // branch for these, so even a fully-formed legacy payload is rejected.
    expect(
      storyCreateRequestSchema.safeParse({ ...payload, topic_ids: [TOPIC], room_id: ROOM }).success,
    ).toBe(false);
  });

  it('keeps location_scope a live optional story field on the surviving branches', () => {
    // The retirement removed the local_update BRANCH, not the story-level
    // location scope — any live submission may still carry one.
    expect(
      storyCreateRequestSchema.safeParse(
        linkBody({ location_scope: { type: 'city', value: 'Lisbon' } }),
      ).success,
    ).toBe(true);
    expect(
      storyCreateRequestSchema.safeParse({
        submission_type: 'original_brief',
        body: 'Detailed first-hand notes…',
        title: 'Bridge closure update',
        topic_ids: [TOPIC],
        room_id: ROOM,
        location_scope: { type: 'region', value: 'Riverside' },
      }).success,
    ).toBe(true);
  });
});

describe('WS-Q.1.3a — home room is required on every branch', () => {
  it.each([
    () => {
      const { room_id: _r, ...rest } = linkBody();
      return rest;
    },
    () => ({
      submission_type: 'image_post',
      upload_id: uuidOf(90),
      alt_text: 'A chart of reservoir levels',
      title: 't',
      topic_ids: [TOPIC],
    }),
    () => ({
      submission_type: 'original_brief',
      body: 'body',
      title: 't',
      topic_ids: [TOPIC],
    }),
  ])('rejects a payload without room_id, naming the field', (build) => {
    const result = storyCreateRequestSchema.safeParse(build());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('room_id'))).toBe(true);
    }
  });

  it('accepts an optional visibility on input (server derives it)', () => {
    expect(storyCreateRequestSchema.safeParse(linkBody({ visibility: 'room_only' })).success).toBe(
      true,
    );
    expect(storyCreateRequestSchema.safeParse(linkBody({ visibility: 'secret' })).success).toBe(
      false,
    );
  });
});

describe('WS-Q.1.3b — deriveStoryVisibility (§14.5 forcing)', () => {
  it.each([
    ['private', 'public', 'room_only'],
    ['private', 'room_only', 'room_only'],
    ['private', undefined, 'room_only'],
    ['public', 'public', 'public'],
    ['public', 'room_only', 'room_only'],
    ['public', undefined, 'public'],
  ] as const)('room=%s requested=%s -> %s', (room, requested, expected) => {
    expect(deriveStoryVisibility(room, requested)).toBe(expected);
  });
});

describe('WS-Q.1.3c — media submission branches', () => {
  const mediaBase = { title: 'Media', topic_ids: [TOPIC], room_id: ROOM };

  it('image_post requires alt text', () => {
    const upload = randomUUID();
    expect(
      storyCreateRequestSchema.safeParse({
        ...mediaBase,
        submission_type: 'image_post',
        upload_id: upload,
      }).success,
    ).toBe(false);
    expect(
      storyCreateRequestSchema.safeParse({
        ...mediaBase,
        submission_type: 'image_post',
        upload_id: upload,
        alt_text: 'A chart of reservoir levels',
      }).success,
    ).toBe(true);
  });

  it('video_post accepts captions as text XOR upload, never both', () => {
    const upload = randomUUID();
    const captionUpload = randomUUID();
    const ok = {
      ...mediaBase,
      submission_type: 'video_post',
      upload_id: upload,
    };
    expect(storyCreateRequestSchema.safeParse(ok).success).toBe(true);
    expect(storyCreateRequestSchema.safeParse({ ...ok, captions_text: 'transcript' }).success).toBe(
      true,
    );
    expect(
      storyCreateRequestSchema.safeParse({ ...ok, captions_upload_id: captionUpload }).success,
    ).toBe(true);
    expect(
      storyCreateRequestSchema.safeParse({
        ...ok,
        captions_text: 'transcript',
        captions_upload_id: captionUpload,
      }).success,
    ).toBe(false);
  });

  it('media posts reject a canonical url field (no crawling)', () => {
    expect(
      storyCreateRequestSchema.safeParse({
        ...mediaBase,
        submission_type: 'image_post',
        upload_id: randomUUID(),
        alt_text: 'x',
        url: 'https://example.com',
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
    room_id: ROOM,
    visibility: 'public' as const,
    media_upload_ref: null,
    media_alt_text: null,
    canonical_public_story_id: null,
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
