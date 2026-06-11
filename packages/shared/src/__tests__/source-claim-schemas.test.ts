// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.2a / WS-F.2.1a / WS-F.2.4 / WS-F.2.5a / WS-F.3.1b / WS-F.1.4f —
// claim, evidence, source, syndication, search, and takedown contracts. The
// source suite includes the §14.3 doctrine assertion: NO truth/credibility/
// reliability scalar exists anywhere in the source shape.
import { describe, expect, it } from 'vitest';
import { claimPublicSchema, evidenceCardPublicSchema } from '../schemas/claim.js';
import { searchRequestSchema, searchResultSchema } from '../schemas/search.js';
import {
  sourceEditRequestSchema,
  sourcePublicSchema,
  syndicationCreateRequestSchema,
} from '../schemas/source.js';
import { takedownActionRequestSchema, takedownCreateRequestSchema } from '../schemas/takedown.js';
import { isFinancialFieldName } from '../utils/financial-fields.js';

// Deterministic UUID literals (shared tests carry no node:crypto dependency —
// this package compiles environment-neutral, the house fixture pattern).
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let uuidCounter = 0;
const randomUUID = (): string => {
  uuidCounter += 1;
  return uuidOf(uuidCounter);
};

const now = () => new Date().toISOString();

describe('claim + evidence schemas (WS-F.1.2a / WS-F.2.5a)', () => {
  const claim = {
    claim_id: randomUUID(),
    story_id: randomUUID(),
    canonical_text: 'The bill passed with 62 votes.',
    claim_status: 'candidate' as const,
    first_seen_story_id: null,
    independence_group_id: null,
    extraction_source: 'system' as const,
    created_at: now(),
    updated_at: now(),
  };

  it('accepts a valid claim, including story-less (cross-story) claims', () => {
    expect(claimPublicSchema.parse(claim)).toEqual(claim);
    expect(claimPublicSchema.safeParse({ ...claim, story_id: null }).success).toBe(true);
  });

  it('rejects empty text and invalid statuses', () => {
    expect(claimPublicSchema.safeParse({ ...claim, canonical_text: '' }).success).toBe(false);
    expect(claimPublicSchema.safeParse({ ...claim, claim_status: 'true' }).success).toBe(false);
  });

  it('omits created_by from the public projection (minimization)', () => {
    expect(claimPublicSchema.safeParse({ ...claim, created_by: randomUUID() }).success).toBe(false);
  });

  it('accepts each evidence type and rejects invalid type/verification values', () => {
    const card = {
      evidence_id: randomUUID(),
      claim_id: claim.claim_id,
      source_id: null,
      submitted_by: randomUUID(),
      evidence_type: 'supports' as const,
      citation_url_or_ref: 'https://example.com/study',
      relevance_note: 'Direct replication',
      verification_state: 'unverified' as const,
      independence_group_id: randomUUID(),
      created_at: now(),
    };
    for (const type of [
      'supports',
      'contradicts',
      'contextualizes',
      'corrects',
      'counterexample',
    ]) {
      expect(evidenceCardPublicSchema.safeParse({ ...card, evidence_type: type }).success).toBe(
        true,
      );
    }
    expect(evidenceCardPublicSchema.safeParse({ ...card, evidence_type: 'proves' }).success).toBe(
      false,
    );
    expect(
      evidenceCardPublicSchema.safeParse({ ...card, verification_state: 'gospel' }).success,
    ).toBe(false);
  });
});

describe('source schemas (WS-F.2.1a / WS-F.2.3a)', () => {
  const source = {
    source_id: randomUUID(),
    name: 'Example News',
    canonical_domain: 'example.com',
    publisher_lineage: [{ name: 'Example Media Group', relationship: 'parent' as const }],
    typical_topics: [randomUUID()],
    correction_history: [
      {
        correction_id: randomUUID(),
        story_id: randomUUID(),
        summary: 'Corrected the vote count after the official record was published.',
        recorded_by: 'steward' as const,
        recorded_at: now(),
      },
    ],
    evidence_type_frequency: { supports: 10, contradicts: 2 },
    community_notes: [],
    display_restrictions: { noindex: false, noarchive: false, excerpt_max_chars: null },
    created_at: now(),
    updated_at: now(),
  };

  it('accepts a full profile and a minimal non-web source', () => {
    expect(sourcePublicSchema.parse(source)).toEqual(source);
    expect(
      sourcePublicSchema.safeParse({
        ...source,
        canonical_domain: null,
        publisher_lineage: null,
      }).success,
    ).toBe(true);
  });

  it('NEVER carries a truth/credibility/reliability scalar (§14.3 doctrine)', () => {
    const keys = Object.keys(sourcePublicSchema.shape);
    for (const key of keys) {
      expect(key).not.toMatch(/truth|credibil|reliab|score|rating/i);
    }
    // Strict parsing means such a field cannot be smuggled in either.
    for (const forbidden of ['truth_score', 'credibility_score', 'reliability_pct']) {
      expect(sourcePublicSchema.safeParse({ ...source, [forbidden]: 0.9 }).success).toBe(false);
      expect(sourceEditRequestSchema.safeParse({ reason: 'edit', [forbidden]: 0.9 }).success).toBe(
        false,
      );
    }
  });

  it('requires a reason on steward edits and rejects malformed lineage', () => {
    expect(sourceEditRequestSchema.safeParse({ name: 'New Name' }).success).toBe(false);
    expect(sourceEditRequestSchema.safeParse({ name: 'New Name', reason: 'rebrand' }).success).toBe(
      true,
    );
    expect(
      sourceEditRequestSchema.safeParse({
        reason: 'x',
        publisher_lineage: [{ relationship: 'parent' }],
      }).success,
    ).toBe(false);
  });

  it('validates syndication create requests', () => {
    expect(
      syndicationCreateRequestSchema.safeParse({
        from_source_id: randomUUID(),
        to_source_id: randomUUID(),
        direction: 'syndicates_to',
        relationship_type: 'wire',
        evidence_ref: 'matched 14 near-duplicate stories',
      }).success,
    ).toBe(true);
    expect(
      syndicationCreateRequestSchema.safeParse({
        from_source_id: randomUUID(),
        to_source_id: randomUUID(),
        direction: 'both_ways',
        relationship_type: 'wire',
        evidence_ref: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('search request schema (WS-F.3.1b)', () => {
  it('validates and coerces query parameters', () => {
    const parsed = searchRequestSchema.parse({ q: 'water policy', limit: '10', prefix: 'true' });
    expect(parsed.limit).toBe(10);
    expect(parsed.prefix).toBe(true);
  });

  it('bounds q and limit, rejects unknown filters', () => {
    expect(searchRequestSchema.safeParse({ q: '' }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ q: 'ok', limit: '500' }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ q: 'ok', boost_paid: 'true' }).success).toBe(false);
  });

  it('search results carry relevance + recency only — no financial field', () => {
    for (const key of Object.keys(searchResultSchema.shape)) {
      expect(isFinancialFieldName(key)).toBe(false);
    }
  });
});

describe('takedown schemas (WS-F.1.4f)', () => {
  it('accepts a structured intake request', () => {
    expect(
      takedownCreateRequestSchema.safeParse({
        target_type: 'story',
        target_id: randomUUID(),
        requester_contact: 'rights@example.com',
        legal_basis: 'copyright',
        claim_detail: 'The full article body is reproduced without a license.',
      }).success,
    ).toBe(true);
  });

  it('rejects short detail, bad bases, and unknown keys', () => {
    const base = {
      target_type: 'story',
      target_id: randomUUID(),
      requester_contact: 'rights@example.com',
      legal_basis: 'copyright',
      claim_detail: 'too short',
    };
    expect(takedownCreateRequestSchema.safeParse(base).success).toBe(false);
    expect(
      takedownCreateRequestSchema.safeParse({
        ...base,
        claim_detail: 'long enough detail',
        legal_basis: 'dislike',
      }).success,
    ).toBe(false);
    expect(
      takedownCreateRequestSchema.safeParse({
        ...base,
        claim_detail: 'long enough detail',
        auto_remove: true,
      }).success,
    ).toBe(false);
  });

  it('validates steward actions', () => {
    expect(
      takedownActionRequestSchema.safeParse({
        action: 'actioned',
        resolution_note: 'Verified copyright claim; story hidden.',
      }).success,
    ).toBe(true);
    expect(takedownActionRequestSchema.safeParse({ action: 'delete_all' }).success).toBe(false);
  });
});

describe('financial-field denylist matcher (WS-F.2.5b)', () => {
  it.each([
    'wallet_address',
    'payment_id',
    'donor_id',
    'treasury_balance',
    'token_amount_paid',
    'tx_hash',
    'chain_id',
    'entry_fee',
    'walletRef',
    'paidAmount',
    'grant_total',
  ])('flags %s', (name) => {
    expect(isFinancialFieldName(name)).toBe(true);
  });

  it.each([
    'feed_mode',
    'tokenized_text',
    'coffee_rating',
    'story_id',
    'canonical_url',
    'relevance_note',
    'freshness_score',
    'independence_group_id',
    'profee', // segment is 'profee', not 'fee'
  ])('passes %s', (name) => {
    expect(isFinancialFieldName(name)).toBe(false);
  });
});
