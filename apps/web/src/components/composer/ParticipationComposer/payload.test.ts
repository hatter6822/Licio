// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Payload builder tests (WS-G.3.4–3.6): composer values → the canonical wire
// shape, validated through the SHARED schema (client/server rule identity),
// with field-level errors mapped back to the form.
import { describe, expect, it } from 'vitest';
import {
  assemblePayload,
  buildContributionPayload,
  isValidCitationUrl,
  parseCitations,
} from './payload.js';

const CTX = {
  threadId: '11111111-1111-4111-8111-111111111111',
  clientDraftId: 'draft-1',
} as const;
const CLAIM = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';

describe('buildContributionPayload', () => {
  it('builds a valid question payload', () => {
    const result = buildContributionPayload('question', { body: 'What changed?' }, CTX);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        type: 'question',
        thread_id: CTX.threadId,
        client_draft_id: CTX.clientDraftId,
        body: 'What changed?',
      });
    }
  });

  it('builds evidence with citations + claim + material type', () => {
    const result = buildContributionPayload(
      'evidence',
      {
        body: 'Primary dataset.',
        citations: 'https://example.org/data\ndoi:10.1000/xyz123',
        target_claim_id: CLAIM,
        evidence_type: 'dataset',
      },
      CTX,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.type === 'evidence') {
      expect(result.payload.citations).toEqual([
        { url: 'https://example.org/data' },
        { url: 'doi:10.1000/xyz123' },
      ]);
      expect(result.payload.evidence_type).toBe('dataset');
    }
  });

  it('maps the answer reply context into parent_contribution_id', () => {
    const result = buildContributionPayload(
      'answer',
      { body: 'Table 3.' },
      { ...CTX, parentContributionId: PARENT },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.type === 'answer') {
      expect(result.payload.parent_contribution_id).toBe(PARENT);
    }
  });

  it('requires the privacy acknowledgment for direct_experience', () => {
    const unchecked = buildContributionPayload(
      'direct_experience',
      { body: 'I was there.', scope: 'Attendee' },
      CTX,
    );
    expect(unchecked.ok).toBe(false);
    if (!unchecked.ok) {
      expect(Object.keys(unchecked.fieldErrors)).toContain('privacy_acknowledged');
    }
    const checked = buildContributionPayload(
      'direct_experience',
      { body: 'I was there.', scope: 'Attendee', privacy_acknowledged: 'true' },
      CTX,
    );
    expect(checked.ok).toBe(true);
  });

  it('reports per-field errors from the shared schema (no drift possible)', () => {
    const result = buildContributionPayload(
      'evidence',
      { body: 'x', citations: '', target_claim_id: CLAIM },
      CTX,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors['citations']).toMatch(/at least one citation/i);
    }
  });

  it('synthesis parses the branch id list and enforces ≥ 2 distinct', () => {
    const one = buildContributionPayload(
      'synthesis',
      { body: 'Both agree.', included_branch_ids: PARENT },
      CTX,
    );
    expect(one.ok).toBe(false);
    const two = buildContributionPayload(
      'synthesis',
      { body: 'Both agree.', included_branch_ids: `${PARENT}, ${CLAIM}` },
      CTX,
    );
    expect(two.ok).toBe(true);
  });

  it('moderation_concern uses the flag context target + ratified reason code', () => {
    const result = buildContributionPayload(
      'moderation_concern',
      { body: 'Targeted harassment.', reason_code: 'MOD_HARASS_001' },
      { ...CTX, targetContributionId: PARENT },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.type === 'moderation_concern') {
      expect(result.payload.target_contribution_id).toBe(PARENT);
      expect(result.payload.urgency).toBe('normal'); // defaulted
    }
    const fabricated = buildContributionPayload(
      'moderation_concern',
      { body: 'x', reason_code: 'MOD_FAKE_001', target_contribution_id: PARENT },
      CTX,
    );
    expect(fabricated.ok).toBe(false);
  });

  it('assemblePayload trims and omits empty optionals (strict schema safety)', () => {
    const candidate = assemblePayload(
      'explanation',
      { body: '  Statute defines it.  ', assumptions: '   ' },
      CTX,
    );
    expect(candidate).toEqual({
      type: 'explanation',
      thread_id: CTX.threadId,
      client_draft_id: CTX.clientDraftId,
      body: 'Statute defines it.',
    });
  });
});

describe('optional fields and context branches', () => {
  it('correction carries the excerpt; counterexample carries source_url', () => {
    const correction = buildContributionPayload(
      'correction',
      {
        body: 'Wrong date.',
        citations: 'https://example.org/x',
        target_claim_id: CLAIM,
        target_text_excerpt: 'on Tuesday',
      },
      CTX,
    );
    expect(correction.ok).toBe(true);
    if (correction.ok && correction.payload.type === 'correction') {
      expect(correction.payload.target_text_excerpt).toBe('on Tuesday');
    }
    const counter = buildContributionPayload(
      'counterexample',
      {
        body: 'County B differs.',
        target_claim_id: CLAIM,
        relevance_explanation: 'Same policy.',
        source_url: 'https://example.org/county-b',
      },
      CTX,
    );
    expect(counter.ok).toBe(true);
    if (counter.ok && counter.payload.type === 'counterexample') {
      expect(counter.payload.source_url).toBe('https://example.org/county-b');
    }
  });

  it('local_context carries location/time; lens + attachments ride the context', () => {
    const local = buildContributionPayload(
      'local_context',
      {
        body: 'Floods every spring.',
        scope: 'Resident',
        location: 'Riverside',
        time_context: 'Spring 2026',
      },
      { ...CTX, lensId: PARENT, attachmentIds: [CLAIM] },
    );
    expect(local.ok).toBe(true);
    if (local.ok && local.payload.type === 'local_context') {
      expect(local.payload.location).toBe('Riverside');
      expect(local.payload.time_context).toBe('Spring 2026');
      expect(local.payload.lens_id).toBe(PARENT);
      expect(local.payload.attachment_ids).toEqual([CLAIM]);
    }
  });

  it('meta_discussion target and question claim ref are optional pass-throughs', () => {
    const meta = buildContributionPayload(
      'meta_discussion',
      { body: 'Merge these?', target_contribution_id: PARENT },
      CTX,
    );
    expect(meta.ok).toBe(true);
    if (meta.ok && meta.payload.type === 'meta_discussion') {
      expect(meta.payload.target_contribution_id).toBe(PARENT);
    }
    const question = buildContributionPayload(
      'question',
      { body: 'Which table?', target_claim_id: CLAIM },
      CTX,
    );
    expect(question.ok).toBe(true);
    if (question.ok && question.payload.type === 'question') {
      expect(question.payload.target_claim_id).toBe(CLAIM);
    }
  });

  it('answer citations parse when present', () => {
    const answer = buildContributionPayload(
      'answer',
      { body: 'Table 3.', citations: 'https://example.org/report' },
      { ...CTX, parentContributionId: PARENT },
    );
    expect(answer.ok).toBe(true);
    if (answer.ok && answer.payload.type === 'answer') {
      expect(answer.payload.citations).toEqual([{ url: 'https://example.org/report' }]);
    }
  });
});

describe('citation helpers (WS-G.3.7a)', () => {
  it('parses one citation per line, skipping blanks', () => {
    expect(parseCitations('https://a.example/x\n\n  doi:10.1000/abc1  \n')).toEqual([
      { url: 'https://a.example/x' },
      { url: 'doi:10.1000/abc1' },
    ]);
  });

  it('validates citation URLs against the shared scheme rules', () => {
    expect(isValidCitationUrl('https://example.org/paper')).toBe(true);
    expect(isValidCitationUrl('doi:10.1000/xyz')).toBe(true);
    expect(isValidCitationUrl('javascript:alert(1)')).toBe(false);
    expect(isValidCitationUrl('ftp://example.org')).toBe(false);
  });
});
