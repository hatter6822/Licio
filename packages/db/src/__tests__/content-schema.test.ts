// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.2.5b — the content-schema financial-field denylist assertion. Runs in
// CI on every PR (no database needed: it introspects the Drizzle table
// definitions, which are the migrations' source of truth). A deliberately
// financial fixture table proves the matcher actually bites, and the
// isolation-classification parity check proves every WS-F table is a BFS
// target of the pay-to-rank proof.
import {
  collectZodFieldNames,
  displayRestrictionsSchema,
  locationScopeSchema,
  publisherLineageEntrySchema,
  sourceCommunityNoteSchema,
  sourceCorrectionSchema,
  submissionMetadataSchema,
} from '@licio/shared';
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  checkContentFinancialDenylist,
  tableColumnNames,
  WS_F_CONTENT_TABLES,
} from '../content-schema-check.js';
import { RANKING_CONTEXT_TABLES } from '../isolation.js';
import { sources } from '../schema/source.js';

describe('WS-F.2.5b content-schema financial denylist', () => {
  it('finds zero financial columns across every WS-F content table', () => {
    const violations = checkContentFinancialDenylist();
    expect(violations).toEqual([]);
  });

  it('enumerates all twenty-four WS-F/WS-G/WS-I content tables (fail-closed coverage)', () => {
    expect(Object.keys(WS_F_CONTENT_TABLES).sort()).toEqual(
      [
        'claims',
        'embeddings',
        'evidence_cards',
        'ingestion_review_items',
        'source_syndications',
        'sources',
        'stories',
        'story_freshness',
        'story_lifecycle_audits',
        'story_lsh_bands',
        'story_signatures',
        'story_source_links',
        'takedown_requests',
        'threads',
        // WS-G forum content.
        'contributions',
        'contribution_edit_history',
        'rooms',
        'room_stewards',
        'room_subscriptions',
        'lenses',
        'summaries',
        'uploads',
        // WS-I ranking surfaces (the feature store + decision logs).
        'ranking_feature_vectors',
        'ranking_decision_logs',
      ].sort(),
    );
  });

  it('also clears the DOCUMENTED JSONB sub-field names (nested matching)', () => {
    const jsonbFields = {
      stories: [
        ...collectZodFieldNames(submissionMetadataSchema),
        ...collectZodFieldNames(locationScopeSchema),
      ],
      sources: [
        ...collectZodFieldNames(publisherLineageEntrySchema),
        ...collectZodFieldNames(sourceCorrectionSchema),
        ...collectZodFieldNames(sourceCommunityNoteSchema),
        ...collectZodFieldNames(displayRestrictionsSchema),
      ],
    };
    // Sanity: the walker actually extracted the nested shapes.
    expect(jsonbFields.stories).toContain('url');
    expect(jsonbFields.stories).toContain('claim_id');
    expect(jsonbFields.sources).toContain('noindex');
    expect(checkContentFinancialDenylist(WS_F_CONTENT_TABLES, jsonbFields)).toEqual([]);
  });

  it('FAILS on a deliberately financial fixture table (the check bites)', () => {
    const poisoned = pgTable('poisoned_content', {
      id: uuid('id').primaryKey(),
      walletAddress: text('wallet_address'),
      amountPaid: integer('amount_paid'),
      donorRef: text('donor_ref'),
      cleanColumn: text('clean_column'),
    });
    const violations = checkContentFinancialDenylist({ poisoned_content: poisoned });
    expect(violations.map((v) => v.field).sort()).toEqual([
      'amount_paid',
      'donor_ref',
      'wallet_address',
    ]);
  });

  it('FAILS on a financial field hidden in a documented JSONB shape', () => {
    const violations = checkContentFinancialDenylist(
      { stories: WS_F_CONTENT_TABLES['stories'] as never },
      { stories: ['reason', 'payment_receipt'] },
    );
    expect(violations).toEqual([{ table: 'stories', field: 'jsonb:payment_receipt' }]);
  });

  it('reports SQL column names (the names migrations and §22.1 use)', () => {
    const storyColumns = tableColumnNames(WS_F_CONTENT_TABLES['stories'] as never);
    expect(storyColumns).toContain('canonical_url');
    expect(storyColumns).toContain('lifecycle_state');
    expect(storyColumns).not.toContain('canonicalUrl');
  });

  it('classifies every WS-F content table as a ranking-context BFS target', () => {
    for (const tableName of Object.keys(WS_F_CONTENT_TABLES)) {
      expect(RANKING_CONTEXT_TABLES.has(`public.${tableName}`), `public.${tableName}`).toBe(true);
    }
  });

  it('source profile carries NO truth/credibility/reliability scalar (§14.3)', () => {
    for (const column of tableColumnNames(sources)) {
      expect(column).not.toMatch(/truth|credibil|reliab|score|rating/i);
    }
  });
});
