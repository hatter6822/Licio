// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  deriveCitationsFromBody,
  extractSourcedStatements,
  resolveCommentSources,
} from './sources.js';

describe('extractSourcedStatements', () => {
  it('returns the inline links in document order with their visible text', () => {
    const body =
      'The [official report](https://example.gov/report) and a [study](https://example.org/study) agree.';
    expect(extractSourcedStatements(body)).toEqual([
      { statement: 'official report', url: 'https://example.gov/report' },
      { statement: 'study', url: 'https://example.org/study' },
    ]);
  });

  it('flattens emphasis inside a link and finds links inside emphasis/lists/quotes', () => {
    const body = [
      'a [**primary** source](https://a.example/1) here',
      '',
      '> quoted [rebuttal](https://b.example/2)',
      '',
      '- item [three](https://c.example/3)',
    ].join('\n');
    const found = extractSourcedStatements(body);
    expect(found.map((s) => s.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ]);
    // The bold-inside-link text is flattened into a single statement.
    expect(found[0]?.statement).toBe('primary source');
  });

  it('falls back to the URL when a link has no visible text (bare <url>)', () => {
    expect(extractSourcedStatements('see <https://example.org/x>')).toEqual([
      { statement: 'https://example.org/x', url: 'https://example.org/x' },
    ]);
  });

  it('is empty for empty/whitespace/null input and text with no links', () => {
    expect(extractSourcedStatements('')).toEqual([]);
    expect(extractSourcedStatements(null)).toEqual([]);
    expect(extractSourcedStatements('just prose, no links here')).toEqual([]);
  });
});

describe('deriveCitationsFromBody', () => {
  it('maps each unique inline link to a Citation with the statement as its title', () => {
    const body = 'A [claim about X](https://example.org/x) with support.';
    expect(deriveCitationsFromBody(body)).toEqual([
      { url: 'https://example.org/x', title: 'claim about X' },
    ]);
  });

  it('dedupes by URL (first statement wins) and caps at MAX_CITATIONS', () => {
    const body = Array.from({ length: 12 }, (_v, i) => `[s${i}](https://example.org/${i})`).join(
      ' ',
    );
    const dupBody = `[first](https://example.org/dup) and [second](https://example.org/dup)`;
    expect(deriveCitationsFromBody(dupBody)).toEqual([
      { url: 'https://example.org/dup', title: 'first' },
    ]);
    expect(deriveCitationsFromBody(body)).toHaveLength(10);
  });

  it('omits non-citation links (mailto is not a source)', () => {
    // A bare-URL link whose text equals its URL yields no redundant title.
    expect(deriveCitationsFromBody('write <https://example.org/x>')).toEqual([
      { url: 'https://example.org/x' },
    ]);
    expect(deriveCitationsFromBody('email <mailto:team@example.org>')).toEqual([]);
  });
});

describe('resolveCommentSources', () => {
  it('merges inline links with legacy bare citations, de-duplicated by URL', () => {
    const body = 'The [report](https://example.org/report) is clear.';
    const legacy = [
      { url: 'https://example.org/report' },
      { url: 'https://example.net/extra', title: 'Extra source' },
    ];
    expect(resolveCommentSources(body, legacy)).toEqual([
      { statement: 'report', url: 'https://example.org/report' },
      { statement: 'Extra source', url: 'https://example.net/extra' },
    ]);
  });

  it('shows a bare legacy citation URL as its own statement when it has no title', () => {
    expect(resolveCommentSources('', [{ url: 'https://example.org/y' }])).toEqual([
      { statement: 'https://example.org/y', url: 'https://example.org/y' },
    ]);
  });
});
