// SPDX-License-Identifier: AGPL-3.0-or-later
import { CONTRIBUTION_TYPES } from '@licio/shared';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { contributions, contributionTypeEnum } from '../schema/contribution.js';
import { attentionAggregates, replyDepthBucketEnum } from '../schema/events.js';

function renderedChecks(table: Parameters<typeof getTableConfig>[0]) {
  const { checks } = getTableConfig(table);
  const dialect = new PgDialect();
  return new Map(checks.map((check) => [check.name, dialect.sqlToQuery(check.value).sql]));
}

describe('WS-T.2 database schema parity', () => {
  it('mirrors the shared contribution enum including comment', () => {
    expect([...contributionTypeEnum.enumValues]).toEqual([...CONTRIBUTION_TYPES]);
  });

  it('allows media-only contribution bodies at the DB ceiling layer', () => {
    const check = renderedChecks(contributions).get('contributions_body_len');
    expect(check).toContain('between 0 and 5000');
  });

  it('adds a durable reply_depth_bucket column with the same bucket domain', () => {
    const columns = getTableConfig(attentionAggregates).columns.map((column) => column.name);
    expect(columns).toContain('branch_depth_bucket');
    expect(columns).toContain('reply_depth_bucket');
    expect([...replyDepthBucketEnum.enumValues]).toEqual(['none', 'shallow', 'moderate', 'deep']);
  });
});
