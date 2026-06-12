// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.2.5b — content-schema financial-field denylist assertion (SPEC
// §21.5/§13.6). The no-pay-to-rank invariant is enforced STRUCTURALLY at the
// producer: no WS-F content/search/embedding table may contain any wallet/
// payment/donation/treasury/financial column, so financial data cannot enter
// the content and ranking surface because the columns cannot exist. The
// denylist itself lives in @licio/shared (FINANCIAL_FIELD_SEGMENTS /
// isFinancialFieldName) so the WS-I.2.1b feature-store check consumes the
// SAME list — producer and consumer can never drift.
//
// Enforced by packages/db/src/__tests__/content-schema.test.ts, which runs in
// CI on every PR (a deliberately financial fixture table must FAIL there),
// and complemented at runtime by the schema-isolation BFS proof
// (isolation.ts), which classifies every WS-F table as a ranking-context BFS
// target.

import { isFinancialFieldName } from '@licio/shared';
import { getTableColumns, type Table } from 'drizzle-orm';
import { claims, evidenceCards } from './schema/claim.js';
import { contributionEditHistory, contributions } from './schema/contribution.js';
import { embeddings } from './schema/embedding.js';
import { ingestionReviewItems } from './schema/ingestion-review.js';
import { rankingDecisionLogs, rankingFeatureVectors } from './schema/ranking.js';
import { lenses, roomStewards, roomSubscriptions, rooms } from './schema/room.js';
import { sourceSyndications, sources } from './schema/source.js';
import {
  stories,
  storyFreshness,
  storyLifecycleAudits,
  storyLshBands,
  storySignatures,
  storySourceLinks,
} from './schema/story.js';
import { summaries } from './schema/summary.js';
import { takedownRequests } from './schema/takedown.js';
import { threads } from './schema/thread.js';
import { uploads } from './schema/upload.js';

/** Every WS-F content/ingestion/search/embedding table, by SQL name. */
export const WS_F_CONTENT_TABLES: Readonly<Record<string, Table>> = {
  stories,
  story_lifecycle_audits: storyLifecycleAudits,
  story_signatures: storySignatures,
  story_lsh_bands: storyLshBands,
  story_source_links: storySourceLinks,
  story_freshness: storyFreshness,
  sources,
  source_syndications: sourceSyndications,
  claims,
  evidence_cards: evidenceCards,
  threads,
  takedown_requests: takedownRequests,
  ingestion_review_items: ingestionReviewItems,
  embeddings,
  // WS-G forum content (the same structural no-pay-to-rank guarantee).
  contributions,
  contribution_edit_history: contributionEditHistory,
  rooms,
  room_stewards: roomStewards,
  room_subscriptions: roomSubscriptions,
  lenses,
  summaries,
  uploads,
  // WS-I ranking surfaces (WS-I.2.1b at the table layer): the feature store
  // and decision logs are THE pay-to-rank boundary — no financial column can
  // exist on them. Their jsonb payload SUB-FIELDS are audited against the
  // same shared denylist by the @licio/ranking schema tests (strict zod
  // closure + collectZodFieldNames), so column and payload layers cannot
  // drift apart.
  ranking_feature_vectors: rankingFeatureVectors,
  ranking_decision_logs: rankingDecisionLogs,
};

/** The SQL column names of a Drizzle table. */
export function tableColumnNames(table: Table): string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name);
}

export interface DenylistViolation {
  table: string;
  field: string;
}

/**
 * Match every column of every given table — plus any documented JSONB
 * sub-field names — against the shared financial denylist. Returns the
 * violations (empty ⇒ the no-pay-to-rank data-layer guarantee holds).
 */
export function checkContentFinancialDenylist(
  tables: Readonly<Record<string, Table>> = WS_F_CONTENT_TABLES,
  jsonbFieldNamesByTable: Readonly<Record<string, readonly string[]>> = {},
): DenylistViolation[] {
  const violations: DenylistViolation[] = [];
  for (const [tableName, table] of Object.entries(tables)) {
    for (const column of tableColumnNames(table)) {
      if (isFinancialFieldName(column)) violations.push({ table: tableName, field: column });
    }
    for (const field of jsonbFieldNamesByTable[tableName] ?? []) {
      if (isFinancialFieldName(field)) {
        violations.push({ table: tableName, field: `jsonb:${field}` });
      }
    }
  }
  return violations;
}
