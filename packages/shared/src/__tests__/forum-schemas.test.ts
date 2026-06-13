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
  contributionCreateSchema,
  contributionUpdateSchema,
} from '../schemas/contribution.js';
import { mapLegacyRoomVisibility, roomCreateRequestSchema } from '../schemas/room.js';
import { summaryCreateRequestSchema, summaryPublicSchema } from '../schemas/summary.js';
import {
  isLegalConversationTransition,
  isLegalThreadSafetyTransition,
  THREAD_CONVERSATION_STATES,
  THREAD_SAFETY_STATES,
} from '../schemas/thread.js';

const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const THREAD = uuidOf(1);
const CLAIM = uuidOf(2);
const PARENT = uuidOf(3);
const TARGET = uuidOf(4);

const base = { thread_id: THREAD, client_draft_id: 'draft-1' } as const;
const citation = { url: 'https://example.org/source' } as const;

describe('WS-G.1.2c contribution create union — valid payloads (11 types)', () => {
  const valid: Array<Record<string, unknown>> = [
    { ...base, type: 'question', body: 'What evidence supports the employment claim?' },
    { ...base, type: 'answer', body: 'The labor report, table 3.', parent_contribution_id: PARENT },
    {
      ...base,
      type: 'evidence',
      body: 'Primary dataset.',
      citations: [citation],
      target_claim_id: CLAIM,
      evidence_type: 'dataset',
    },
    {
      ...base,
      type: 'correction',
      body: 'The date is wrong.',
      target_claim_id: CLAIM,
      citations: [citation],
      target_text_excerpt: 'on June 3',
    },
    {
      ...base,
      type: 'synthesis',
      body: 'Both branches agree on X.',
      included_branch_ids: [uuidOf(5), uuidOf(6)],
      uncertainty_note: 'Y is unresolved.',
    },
    {
      ...base,
      type: 'counterexample',
      body: 'County B saw the opposite.',
      target_claim_id: CLAIM,
      relevance_explanation: 'Same policy, different outcome.',
    },
    {
      ...base,
      type: 'explanation',
      body: 'The statute defines this term narrowly.',
      assumptions: 'Current case law.',
      caveats: 'Pending appeal.',
    },
    {
      ...base,
      type: 'local_context',
      body: 'The intersection floods every spring.',
      scope: 'Riverside resident',
    },
    {
      ...base,
      type: 'direct_experience',
      body: 'I attended the hearing.',
      scope: 'Hearing attendee',
      privacy_acknowledged: true,
    },
    {
      ...base,
      type: 'moderation_concern',
      body: 'This is targeted harassment.',
      target_contribution_id: TARGET,
      reason_code: 'MOD_HARASS_001',
      urgency: 'normal',
    },
    {
      ...base,
      type: 'meta_discussion',
      body: 'Should these two branches be merged?',
      target_contribution_id: TARGET,
    },
  ];

  it.each(
    valid.map((v) => [v['type'] as string, v] as const),
  )('accepts a valid %s', (_t, payload) => {
    expect(contributionCreateSchema.safeParse(payload).success).toBe(true);
  });

  it('covers all 11 types exactly once', () => {
    expect(new Set(valid.map((v) => v['type'])).size).toBe(11);
  });
});

describe('WS-G.1.2b per-type required-field enforcement', () => {
  it.each([
    ['question without body', { ...base, type: 'question', body: '' }],
    ['answer without parent', { ...base, type: 'answer', body: 'x' }],
    [
      'evidence without citations',
      { ...base, type: 'evidence', body: 'x', citations: [], target_claim_id: CLAIM },
    ],
    [
      'evidence without target claim',
      { ...base, type: 'evidence', body: 'x', citations: [citation] },
    ],
    [
      'correction without citations',
      { ...base, type: 'correction', body: 'x', target_claim_id: CLAIM, citations: [] },
    ],
    [
      'correction without target claim',
      { ...base, type: 'correction', body: 'x', citations: [citation] },
    ],
    [
      'correction with six citations',
      {
        ...base,
        type: 'correction',
        body: 'x',
        target_claim_id: CLAIM,
        citations: Array.from({ length: 6 }, () => citation),
      },
    ],
    [
      'synthesis with one branch',
      { ...base, type: 'synthesis', body: 'x', included_branch_ids: [uuidOf(5)] },
    ],
    [
      'synthesis with duplicate branches',
      { ...base, type: 'synthesis', body: 'x', included_branch_ids: [uuidOf(5), uuidOf(5)] },
    ],
    [
      'counterexample without relevance',
      { ...base, type: 'counterexample', body: 'x', target_claim_id: CLAIM },
    ],
    ['local_context without scope', { ...base, type: 'local_context', body: 'x' }],
    [
      'direct_experience without acknowledgment',
      { ...base, type: 'direct_experience', body: 'x', scope: 's' },
    ],
    [
      'direct_experience with false acknowledgment',
      { ...base, type: 'direct_experience', body: 'x', scope: 's', privacy_acknowledged: false },
    ],
    [
      'moderation_concern without target',
      { ...base, type: 'moderation_concern', body: 'x', reason_code: 'MOD_SPAM_001' },
    ],
    [
      'moderation_concern with unknown reason code',
      {
        ...base,
        type: 'moderation_concern',
        body: 'x',
        target_contribution_id: TARGET,
        reason_code: 'MOD_FAKE_001',
      },
    ],
    ['unknown type', { ...base, type: 'like', body: 'x' }],
    ['unknown extra key (strict)', { ...base, type: 'question', body: 'x', upvotes: 3 }],
  ])('rejects %s', (_name, payload) => {
    expect(contributionCreateSchema.safeParse(payload).success).toBe(false);
  });

  it('enforces the per-type body caps', () => {
    expect(
      contributionCreateSchema.safeParse({ ...base, type: 'question', body: 'q'.repeat(2_001) })
        .success,
    ).toBe(false);
    expect(
      contributionCreateSchema.safeParse({
        ...base,
        type: 'evidence',
        body: 'r'.repeat(501),
        citations: [citation],
        target_claim_id: CLAIM,
      }).success,
    ).toBe(false);
    expect(
      contributionCreateSchema.safeParse({
        ...base,
        type: 'synthesis',
        body: 's'.repeat(5_000),
        included_branch_ids: [uuidOf(5), uuidOf(6)],
      }).success,
    ).toBe(true);
  });

  it('produces specific per-field messages, never a generic "invalid input"', () => {
    const result = contributionCreateSchema.safeParse({
      ...base,
      type: 'evidence',
      body: 'x',
      citations: [],
      target_claim_id: CLAIM,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('at least one citation'))).toBe(
        true,
      );
    }
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
      contributionUpdateSchema.safeParse({ contribution_id: uuidOf(9), type: 'evidence' }).success,
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

describe('WS-G.1.4 summary schemas', () => {
  const summary = {
    summary_id: uuidOf(7),
    thread_id: THREAD,
    layer: 'community_synthesis',
    body: 'Branches A and B agree on the dataset provenance.',
    cited_branch_ids: [uuidOf(5)],
    cited_evidence_ids: [],
    unresolved_uncertainty: 'Whether the sampling window was representative.',
    minority_views_note: null,
    machine_generated: false,
    authored_by_handle: 'mara',
    approved_by_handle: null,
    created_at: '2026-06-11T00:00:00.000Z',
    updated_at: '2026-06-11T00:00:00.000Z',
  };

  it('requires unresolved uncertainty for community/steward layers (§24.3)', () => {
    expect(summaryPublicSchema.safeParse(summary).success).toBe(true);
    expect(
      summaryPublicSchema.safeParse({ ...summary, unresolved_uncertainty: null }).success,
    ).toBe(false);
    expect(
      summaryPublicSchema.safeParse({
        ...summary,
        layer: 'automated_draft',
        machine_generated: true,
        unresolved_uncertainty: null,
      }).success,
    ).toBe(true);
  });

  it('pins the machine-generated label to automated drafts exactly', () => {
    expect(summaryPublicSchema.safeParse({ ...summary, machine_generated: true }).success).toBe(
      false,
    );
    expect(
      summaryPublicSchema.safeParse({
        ...summary,
        layer: 'automated_draft',
        machine_generated: false,
      }).success,
    ).toBe(false);
  });

  it('user creation contract refuses automated_draft and demands uncertainty', () => {
    expect(
      summaryCreateRequestSchema.safeParse({
        thread_id: THREAD,
        layer: 'automated_draft',
        body: 'x',
        unresolved_uncertainty: 'y',
      }).success,
    ).toBe(false);
    expect(
      summaryCreateRequestSchema.safeParse({
        thread_id: THREAD,
        layer: 'community_synthesis',
        body: 'x',
      }).success,
    ).toBe(false);
  });
});
