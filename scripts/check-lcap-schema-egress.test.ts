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

describe('what NAMES a field', () => {
  it('reads a token spelled in a template chunk', () => {
    // The whole-text search this replaced covered these; collecting only the
    // hole-free template form would have lost the case.
    const source = `export const x = \`p ipAddress \${y}\`;`;
    expect(findSchemaEgressIssues('f.ts', source)).toHaveLength(1);
  });

  it('is not fooled by a string that contains a comment opener', () => {
    // The two regexes it replaced were string-unaware: `'a // b'` lost its tail,
    // so a real field declared after it on the same line could be HIDDEN.
    expect(
      findSchemaEgressIssues(
        'f.ts',
        "export const u = 'a // b'; export const s = { latitude: 1 };",
      ),
    ).toHaveLength(1);
  });

  it('still ignores a token that only appears in prose', () => {
    expect(
      findSchemaEgressIssues('f.ts', '// followers is forbidden\nexport const x = 1;'),
    ).toEqual([]);
  });
});

describe('a COMPOSED field name', () => {
  // The collector splits every literal into words, so a name assembled from
  // pieces recorded `ip_` and `address` and never the forbidden token.  The
  // composition is where the runtime name comes from, so it is folded first.
  it.each([
    ['concatenation', "export const s = z.object({ ['ip_' + 'address']: z.string() });"],
    // Built, so a literal `${` never appears inside a plain string here.
    ['a template', `export const s = z.object({ [\`ip_$${'{'}'address'}\`]: z.string() });`],
  ])('catches a forbidden key built by %s', (_label, source) => {
    expect(findSchemaEgressIssues('x.ts', source).length).toBeGreaterThan(0);
  });

  it.each([
    ['a harmless composition', "export const s = z.object({ ['room_' + 'id']: z.string() });"],
    ['a hole that is not static', `export const s = z.object({ [\`ip_$${'{'}x}\`]: z.string() });`],
  ])('does not flag %s', (_label, source) => {
    expect(findSchemaEgressIssues('x.ts', source)).toEqual([]);
  });
});
