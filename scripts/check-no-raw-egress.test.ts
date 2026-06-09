// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { findEgressIssues, findGuardIssues, findSchemaIssues } from './check-no-raw-egress.js';

describe('findEgressIssues', () => {
  it('passes the sanctioned bucketed-egress import', () => {
    const content = "import { uploadAttentionAggregates } from '../lib/api.js';";
    expect(findEgressIssues('aggregate.ts', content)).toEqual([]);
  });

  it('flags a direct fetch in the signal layer', () => {
    expect(findEgressIssues('processor.ts', "void fetch('/v1/raw', { method: 'POST' });")).toEqual([
      expect.stringContaining('direct fetch()'),
    ]);
  });

  it('flags sendBeacon and WebSocket egress', () => {
    expect(findEgressIssues('a.ts', 'navigator.sendBeacon(url, blob);')).toHaveLength(1);
    expect(findEgressIssues('b.ts', 'const s = new WebSocket(url);')).toHaveLength(1);
  });

  it('flags importing a non-sanctioned BFF function into the signal layer', () => {
    const content = "import { createContribution } from '../lib/api.js';";
    const issues = findEgressIssues('leak.ts', content);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('createContribution');
  });

  it('ignores forbidden constructs that only appear in comments', () => {
    const content = '// never call fetch() directly here\nconst x = 1;';
    expect(findEgressIssues('c.ts', content)).toEqual([]);
  });
});

describe('findGuardIssues', () => {
  it('passes when the runtime guard is present', () => {
    expect(findGuardIssues('this.add = (a) => assertNoRawEgress(a);')).toEqual([]);
  });

  it('flags removal of the runtime guard', () => {
    expect(findGuardIssues('this.add = (a) => this.pending.push(a);')).toHaveLength(1);
  });
});

describe('findSchemaIssues', () => {
  it('passes a bucket-only schema', () => {
    const content =
      'z.object({ active_dwell_bucket: dwellBucketSchema, source_opened: z.boolean() })';
    expect(findSchemaIssues(content)).toEqual([]);
  });

  it('flags a raw-trace field in the schema', () => {
    expect(findSchemaIssues('z.object({ scrollY: z.number() })')).toEqual([
      expect.stringContaining('scrollY'),
    ]);
  });
});
