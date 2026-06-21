// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { findSchemaEgressIssues } from './check-lcap-schema-egress.js';

describe('findSchemaEgressIssues (WS-R.14.3 LCAP schema denylist)', () => {
  it('passes a clean LCAP record schema', () => {
    const content = `
      export const recordSchema = z.object({
        record_version: z.literal(2),
        home_room_id: z.string(),
        priority: z.number(),
      });`;
    expect(findSchemaEgressIssues('records.ts', content)).toEqual([]);
  });

  it('flags a raw attention-trace field', () => {
    const issues = findSchemaEgressIssues('r.ts', 'z.object({ dwellMs: z.number() })');
    expect(issues[0]).toContain('raw attention trace');
    expect(issues[0]).toContain('dwellMs');
  });

  it('flags a network/location identifier field', () => {
    expect(findSchemaEgressIssues('r.ts', 'z.object({ ip_address: z.string() })')[0]).toContain(
      'network/location identifier',
    );
    expect(findSchemaEgressIssues('r.ts', 'z.object({ longitude: z.number() })')[0]).toContain(
      'longitude',
    );
  });

  it('flags an applause field', () => {
    expect(findSchemaEgressIssues('r.ts', 'z.object({ like_count: z.number() })')[0]).toContain(
      'applause field',
    );
    expect(findSchemaEgressIssues('r.ts', 'z.object({ upvotes: z.number() })')[0]).toContain(
      'upvotes',
    );
  });

  it('does not false-positive on "content-addressed" or "PulseReaction"', () => {
    expect(findSchemaEgressIssues('r.ts', '// content-addressed; PulseReaction type')).toEqual([]);
    expect(
      findSchemaEgressIssues('r.ts', 'export type PulseReaction = { posture: string };'),
    ).toEqual([]);
  });

  it('ignores forbidden tokens that only appear in comments', () => {
    expect(findSchemaEgressIssues('r.ts', '/* no karma here */ const x = 1;')).toEqual([]);
  });
});
