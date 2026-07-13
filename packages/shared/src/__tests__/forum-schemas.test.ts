// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical forum schema tests (WS-G.1.1/1.2b/1.2c/1.4/2.1/2.2): the
// per-type validation table, citation scheme safety, the compile-time
// absence of `type` from updates, exhaustive state-machine tables, and the
// WS-A.1.2 reason-code pinning.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isModerationReasonCode,
  MODERATION_CATEGORIES,
  MODERATION_CRYPTO_MODES,
  MODERATION_REASON_CODES,
} from '../constants/moderation.js';
import type { ContributionUpdate } from '../schemas/contribution.js';
import {
  citationSchema,
  commentItemSchema,
  contributionPublicSchema,
  contributionUpdateSchema,
  contributionWriteCreateSchema,
} from '../schemas/contribution.js';
import {
  debateOverrideRequestSchema,
  debatePositionUpdateSchema,
  isLegalDebateTransition,
} from '../schemas/debate.js';
import { mapLegacyRoomVisibility, roomCreateRequestSchema } from '../schemas/room.js';
import {
  isLegalConversationTransition,
  isLegalThreadSafetyTransition,
  THREAD_CONVERSATION_STATES,
  THREAD_SAFETY_STATES,
} from '../schemas/thread.js';

const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const THREAD = uuidOf(1);
const TARGET_COMMENT = uuidOf(3);
const TARGET_STORY = uuidOf(4);

const base = { thread_id: THREAD, client_draft_id: 'draft-1' } as const;
const citation = { url: 'https://example.org/source' } as const;

describe('WS-T.1.2 contribution create union — comment-first writes', () => {
  const validComment = { ...base, type: 'comment', body: 'A plain comment.' } as const;
  const validCorrection = {
    ...base,
    type: 'correction',
    body: 'The date is wrong.',
    target_contribution_id: TARGET_COMMENT,
    citations: [citation],
    target_text_excerpt: 'on June 3',
  } as const;

  it('accepts exactly comment and correction for new writes', () => {
    for (const payload of [validComment, validCorrection]) {
      expect(contributionWriteCreateSchema.safeParse(payload).success).toBe(true);
    }
    for (const type of [
      'question',
      'answer',
      'evidence',
      'synthesis',
      'counterexample',
      'explanation',
      'local_context',
      'direct_experience',
      'moderation_concern',
      'meta_discussion',
    ]) {
      expect(
        contributionWriteCreateSchema.safeParse({ ...base, type, body: 'legacy' }).success,
      ).toBe(false);
    }
  });

  it('normalizes comment bodies and enforces body-or-media', () => {
    expect(contributionWriteCreateSchema.parse(validComment).body).toBe('A plain comment.');
    expect(
      contributionWriteCreateSchema.parse({
        ...base,
        type: 'comment',
        body: '   ',
        attachment_ids: [uuidOf(8)],
      }).body,
    ).toBe('');
    expect(
      contributionWriteCreateSchema.safeParse({
        ...base,
        type: 'comment',
        attachment_ids: [uuidOf(8)],
      }).success,
    ).toBe(true);
    const rejected = contributionWriteCreateSchema.safeParse({
      ...base,
      type: 'comment',
      body: '   ',
    });
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues[0]?.path).toEqual(['body']);
  });

  it('keeps the correction citation requirement unchanged', () => {
    expect(
      contributionWriteCreateSchema.safeParse({ ...validCorrection, citations: [] }).success,
    ).toBe(false);
  });

  it('lets a plain comment attach optional source links', () => {
    expect(
      contributionWriteCreateSchema.safeParse({ ...validComment, citations: [citation] }).success,
    ).toBe(true);
    // Sources stay OPTIONAL — an unsourced comment is still valid.
    expect(contributionWriteCreateSchema.safeParse(validComment).success).toBe(true);
    // But a malformed source URL is rejected at the boundary.
    expect(
      contributionWriteCreateSchema.safeParse({
        ...validComment,
        citations: [{ url: 'javascript:alert(1)' }],
      }).success,
    ).toBe(false);
  });

  it('requires a correction to target exactly one comment or story', () => {
    // A story target is accepted.
    expect(
      contributionWriteCreateSchema.safeParse({
        ...base,
        type: 'correction',
        body: 'The headline overstates it.',
        target_story_id: TARGET_STORY,
        citations: [citation],
      }).success,
    ).toBe(true);
    // Zero targets is rejected.
    const zero = contributionWriteCreateSchema.safeParse({
      ...base,
      type: 'correction',
      body: 'No target.',
      citations: [citation],
    });
    expect(zero.success).toBe(false);
    // Two targets is rejected.
    expect(
      contributionWriteCreateSchema.safeParse({
        ...base,
        type: 'correction',
        body: 'Two targets.',
        target_contribution_id: TARGET_COMMENT,
        target_story_id: TARGET_STORY,
        citations: [citation],
      }).success,
    ).toBe(false);
  });

  it('defaults dispute posture to none on the public projection', () => {
    const parsed = contributionPublicSchema.safeParse({
      contribution_id: uuidOf(20),
      thread_id: THREAD,
      type: 'comment',
      body: 'A sourced comment.',
      citations: [citation],
      metadata: {},
      target_claim_id: null,
      parent_contribution_id: null,
      author_handle: 'mara',
      author_display_name: 'Mara',
      is_author: false,
      depth: 0,
      child_count: 0,
      moderation_state: 'published',
      edited: false,
      created_at: '2026-06-11T00:00:00.000Z',
      updated_at: '2026-06-11T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dispute_status).toBe('none');
      expect(parsed.data.active_debate_id).toBeNull();
    }
  });

  it('projects exactly the two-type union publicly (legacy types are fully retired)', () => {
    const publicRow = {
      contribution_id: uuidOf(9),
      thread_id: THREAD,
      type: 'comment',
      body: 'A migrated legacy row reads as a comment.',
      citations: [],
      metadata: {},
      target_claim_id: null,
      parent_contribution_id: null,
      author_handle: 'mara',
      author_display_name: 'Mara',
      is_author: false,
      depth: 0,
      child_count: 0,
      moderation_state: 'published',
      edited: false,
      created_at: '2026-06-11T00:00:00.000Z',
      updated_at: '2026-06-11T00:00:00.000Z',
    };
    // Both live types parse on the public projection…
    expect(contributionPublicSchema.safeParse(publicRow).success).toBe(true);
    expect(
      contributionPublicSchema.safeParse({
        ...publicRow,
        type: 'correction',
        body: 'The date is wrong.',
        citations: [citation],
        metadata: { target_story_id: TARGET_STORY },
      }).success,
    ).toBe(true);
    // …and NO legacy type survives even on the read path — migration 0076
    // rewrote every stray row to 'comment', so the projection enum is closed.
    for (const legacy of [
      'question',
      'answer',
      'evidence',
      'synthesis',
      'counterexample',
      'explanation',
      'local_context',
      'direct_experience',
      'moderation_concern',
      'meta_discussion',
    ]) {
      expect(
        contributionPublicSchema.safeParse({ ...publicRow, type: legacy }).success,
        `legacy public type ${legacy} must be rejected`,
      ).toBe(false);
    }
  });

  it('models resolved media and nested comment items separately from the flat projection', () => {
    const publicRow = {
      contribution_id: uuidOf(10),
      thread_id: THREAD,
      type: 'comment',
      body: '',
      citations: [],
      metadata: { attachment_ids: [uuidOf(11)] },
      target_claim_id: null,
      parent_contribution_id: null,
      author_handle: 'mara',
      author_display_name: 'Mara',
      is_author: true,
      depth: 0,
      child_count: 1,
      moderation_state: 'published',
      edited: false,
      created_at: '2026-06-11T00:00:00.000Z',
      updated_at: '2026-06-11T00:00:00.000Z',
      media: [
        {
          upload_id: uuidOf(11),
          url: '/v1/uploads/11',
          kind: 'image',
          content_type: 'image/gif',
          alt_text: 'Animated diagram',
          animatable: true,
        },
      ],
    };
    expect(contributionPublicSchema.safeParse(publicRow).success).toBe(true);
    expect(
      commentItemSchema.safeParse({
        ...publicRow,
        replies: [],
        reply_count: 1,
        has_more_replies: false,
      }).success,
    ).toBe(true);
  });
});

describe('WS-T debate arena contracts', () => {
  it('validates a position update (summary + at least one source)', () => {
    expect(
      debatePositionUpdateSchema.safeParse({ summary: 'My case.', citations: [citation] }).success,
    ).toBe(true);
    // A position with no source is rejected — a debate is always sourced.
    expect(
      debatePositionUpdateSchema.safeParse({ summary: 'My case.', citations: [] }).success,
    ).toBe(false);
    // An empty summary is rejected.
    expect(
      debatePositionUpdateSchema.safeParse({ summary: '   ', citations: [citation] }).success,
    ).toBe(false);
  });

  it('validates a steward override (winner + reason)', () => {
    expect(
      debateOverrideRequestSchema.safeParse({ winner: 'challenger', reason: 'Sources hold.' })
        .success,
    ).toBe(true);
    expect(debateOverrideRequestSchema.safeParse({ winner: 'nobody', reason: 'x' }).success).toBe(
      false,
    );
    expect(debateOverrideRequestSchema.safeParse({ winner: 'incumbent', reason: '' }).success).toBe(
      false,
    );
  });

  it('enforces the arena state graph (open→locked→awaiting_verdict→judged→resolved; withdrawn/concession early closes; terminal)', () => {
    expect(isLegalDebateTransition('open', 'locked')).toBe(true);
    expect(isLegalDebateTransition('locked', 'awaiting_verdict')).toBe(true);
    expect(isLegalDebateTransition('awaiting_verdict', 'judged')).toBe(true);
    expect(isLegalDebateTransition('judged', 'resolved')).toBe(true);
    // Party-driven early closes while open: withdrawal and concession.
    expect(isLegalDebateTransition('open', 'withdrawn')).toBe(true);
    expect(isLegalDebateTransition('open', 'resolved')).toBe(true);
    // Illegal skips, locked-in states, and the two terminal states.
    expect(isLegalDebateTransition('open', 'judged')).toBe(false);
    expect(isLegalDebateTransition('open', 'awaiting_verdict')).toBe(false);
    expect(isLegalDebateTransition('locked', 'withdrawn')).toBe(false);
    expect(isLegalDebateTransition('locked', 'resolved')).toBe(false);
    expect(isLegalDebateTransition('resolved', 'open')).toBe(false);
    expect(isLegalDebateTransition('withdrawn', 'open')).toBe(false);
  });
});

describe('WS-G.1.2c citation schema', () => {
  it('accepts http/https/doi and rejects dangerous schemes', () => {
    expect(citationSchema.safeParse({ url: 'https://example.org/x' }).success).toBe(true);
    expect(citationSchema.safeParse({ url: 'http://example.org/x' }).success).toBe(true);
    expect(citationSchema.safeParse({ url: 'doi:10.1000/xyz123' }).success).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html;base64,x',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.org/x',
      'doi:11.1000/not-a-doi',
    ]) {
      expect(citationSchema.safeParse({ url: bad }).success).toBe(false);
    }
  });

  it('accepts optional title/accessed_at/archive_url and rejects unknown keys', () => {
    expect(
      citationSchema.safeParse({
        url: 'https://example.org',
        title: 'Example',
        accessed_at: '2026-06-11T00:00:00.000Z',
        archive_url: 'https://archive.example/x',
      }).success,
    ).toBe(true);
    expect(citationSchema.safeParse({ url: 'https://example.org', clicks: 5 }).success).toBe(false);
  });
});

describe('WS-G.1.2c update schema — type can never change', () => {
  it('has no `type` key at the type level (compile-time guarantee)', () => {
    expectTypeOf<ContributionUpdate>().not.toHaveProperty('type');
  });

  it('rejects a runtime attempt to smuggle `type`', () => {
    expect(
      contributionUpdateSchema.safeParse({ contribution_id: uuidOf(9), type: 'comment' }).success,
    ).toBe(false);
  });
});

describe('WS-G.1.1 conversation state machine (table-driven, exhaustive)', () => {
  const LEGAL = new Set([
    'active→deepening',
    'active→tense',
    'active→under_review',
    'active→resolved',
    'active→archived',
    'deepening→archived',
    'tense→under_review',
    'tense→archived',
    'under_review→tense',
    'under_review→active',
    'under_review→resolved',
    'under_review→archived',
    'resolved→archived',
  ]);

  it('accepts exactly the legal graph and rejects every other edge', () => {
    for (const from of THREAD_CONVERSATION_STATES) {
      for (const to of THREAD_CONVERSATION_STATES) {
        if (from === to) continue; // self-loops are not transitions
        expect(isLegalConversationTransition(from, to)).toBe(LEGAL.has(`${from}→${to}`));
      }
    }
  });

  it('makes archived terminal', () => {
    for (const to of THREAD_CONVERSATION_STATES) {
      expect(isLegalConversationTransition('archived', to)).toBe(false);
    }
  });
});

describe('WS-G.1.1 thread safety state machine', () => {
  const LEGAL = new Set([
    'normal→elevated',
    'normal→under_review',
    'normal→restricted',
    'elevated→normal',
    'elevated→under_review',
    'elevated→restricted',
    'under_review→normal',
    'under_review→elevated',
    'under_review→restricted',
    'restricted→under_review',
  ]);

  it('accepts exactly the legal graph and rejects every other edge', () => {
    for (const from of THREAD_SAFETY_STATES) {
      for (const to of THREAD_SAFETY_STATES) {
        if (from === to) continue;
        expect(isLegalThreadSafetyTransition(from, to)).toBe(LEGAL.has(`${from}→${to}`));
      }
    }
  });

  it('de-escalation from restricted always passes review', () => {
    expect(isLegalThreadSafetyTransition('restricted', 'normal')).toBe(false);
    expect(isLegalThreadSafetyTransition('restricted', 'under_review')).toBe(true);
  });
});

describe('WS-A.1.2 reason-code pinning (policy-document mirror)', () => {
  it('carries exactly 51 codes: 12 categories × 3 + 15 crypto modes', () => {
    expect(MODERATION_CATEGORIES).toHaveLength(12);
    expect(MODERATION_CRYPTO_MODES).toHaveLength(15);
    expect(MODERATION_REASON_CODES).toHaveLength(51);
    expect(new Set(MODERATION_REASON_CODES).size).toBe(51);
  });

  it('recognizes ratified codes and rejects fabrications', () => {
    expect(isModerationReasonCode('MOD_HARASS_002')).toBe(true);
    expect(isModerationReasonCode('MOD_CRYPTO_DRAIN_001')).toBe(true);
    expect(isModerationReasonCode('MOD_CRYPTO_DRAIN_002')).toBe(false);
    expect(isModerationReasonCode('MOD_NOPE_001')).toBe(false);
  });
});

describe('WS-G.2.3c room creation — per-type required fields', () => {
  const roomBase = { name: 'Public Health', description: 'Evidence-led discussion.' } as const;

  it.each([
    ['global_topic', { ...roomBase, room_type: 'global_topic', initial_topics: ['health'] }],
    [
      'local_geographic',
      { ...roomBase, room_type: 'local_geographic', geographic_scope: 'Riverside district' },
    ],
    [
      'professional_domain',
      { ...roomBase, room_type: 'professional_domain', domain_descriptor: 'Epidemiology' },
    ],
    [
      'event',
      {
        ...roomBase,
        room_type: 'event',
        event_start: '2026-06-11T00:00:00.000Z',
        event_end: '2026-06-12T00:00:00.000Z',
      },
    ],
    ['learning', { ...roomBase, room_type: 'learning', curriculum_outline: 'Week 1: sources.' }],
    ['steward', { ...roomBase, room_type: 'steward', visibility: 'private' }],
  ])('accepts a valid %s room', (_t, payload) => {
    expect(roomCreateRequestSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    ['global_topic without topics', { ...roomBase, room_type: 'global_topic', initial_topics: [] }],
    [
      'event with end before start',
      {
        ...roomBase,
        room_type: 'event',
        event_start: '2026-06-12T00:00:00.000Z',
        event_end: '2026-06-11T00:00:00.000Z',
      },
    ],
    [
      'steward room with public visibility',
      { ...roomBase, room_type: 'steward', visibility: 'public' },
    ],
    ['learning without curriculum', { ...roomBase, room_type: 'learning' }],
  ])('rejects %s', (_name, payload) => {
    expect(roomCreateRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe('WS-Q.1.1a binary visibility + join/posting coherence', () => {
  const roomBase = {
    name: 'Public Health',
    description: 'Evidence-led discussion.',
    room_type: 'global_topic' as const,
    initial_topics: ['health'],
  };

  it('accepts the binary visibility values and rejects the legacy three-value enum', () => {
    expect(roomCreateRequestSchema.safeParse({ ...roomBase, visibility: 'public' }).success).toBe(
      true,
    );
    expect(roomCreateRequestSchema.safeParse({ ...roomBase, visibility: 'private' }).success).toBe(
      true,
    );
    for (const legacy of ['restricted', 'expert_led']) {
      expect(roomCreateRequestSchema.safeParse({ ...roomBase, visibility: legacy }).success).toBe(
        false,
      );
    }
  });

  it('carries join_model/posting_policy and rejects incoherent public combinations', () => {
    // private rooms admit every join model + posting policy.
    expect(
      roomCreateRequestSchema.safeParse({
        ...roomBase,
        visibility: 'private',
        join_model: 'invite',
        posting_policy: 'experts_and_stewards',
      }).success,
    ).toBe(true);
    expect(
      roomCreateRequestSchema.safeParse({
        ...roomBase,
        visibility: 'private',
        join_model: 'request_approval',
      }).success,
    ).toBe(true);
    // public rooms only allow the open join model.
    expect(
      roomCreateRequestSchema.safeParse({ ...roomBase, visibility: 'public', join_model: 'open' })
        .success,
    ).toBe(true);
    for (const badJoin of ['request_approval', 'invite']) {
      expect(
        roomCreateRequestSchema.safeParse({
          ...roomBase,
          visibility: 'public',
          join_model: badJoin,
        }).success,
      ).toBe(false);
    }
  });

  it('mapLegacyRoomVisibility never widens read access (no-op property)', () => {
    expect(mapLegacyRoomVisibility('public')).toEqual({
      visibility: 'public',
      join_model: 'open',
      posting_policy: 'all_members',
    });
    expect(mapLegacyRoomVisibility('restricted')).toEqual({
      visibility: 'private',
      join_model: 'request_approval',
      posting_policy: 'all_members',
    });
    expect(mapLegacyRoomVisibility('expert_led')).toEqual({
      visibility: 'private',
      join_model: 'request_approval',
      posting_policy: 'experts_and_stewards',
    });
    for (const legacy of ['restricted', 'expert_led'] as const) {
      expect(mapLegacyRoomVisibility(legacy).visibility).not.toBe('public');
    }
  });
});
