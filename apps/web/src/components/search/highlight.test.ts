// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Query-term highlighting: tokenization mirrors the server, ranges merge, and
// the output is React nodes (plain strings + <mark> elements) — never markup.
import { describe, expect, it } from 'vitest';
import { highlightMatches, matchRanges, queryTokens } from './highlight.js';

describe('queryTokens (server tokenizer mirror)', () => {
  it('lowercases, splits on non-alphanumerics, and caps at 12 tokens', () => {
    expect(queryTokens(`Quantum' OR 1=1; --`)).toEqual(['quantum', 'or', '1', '1']);
    expect(queryTokens('a b c d e f g h i j k l m n')).toHaveLength(12);
    expect(queryTokens('')).toEqual([]);
  });
});

describe('matchRanges', () => {
  it('finds case-insensitive occurrences and merges overlaps', () => {
    expect(matchRanges('Reservoir reservoir', ['reservoir'])).toEqual([
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ]);
    // "res" ⊂ "reservoir": overlapping token ranges merge into one.
    expect(matchRanges('Reservoir', ['res', 'reservoir'])).toEqual([{ start: 0, end: 9 }]);
    expect(matchRanges('nothing here', ['absent'])).toEqual([]);
    expect(matchRanges('text', [''])).toEqual([]);
  });

  it('never builds a regex from the query (special characters are literal)', () => {
    // A token like "1" (post-tokenization) is safe; raw regex metacharacters
    // can only arrive via matchRanges' plain indexOf scan.
    expect(matchRanges('price is $5 (five)', ['5'])).toEqual([{ start: 10, end: 11 }]);
  });

  it('degrades to no-highlight when case-lowering changes the string length', () => {
    // 'İ' (U+0130) lowercases to "i" + combining dot (two units): offsets
    // found in the lowered text would misalign against the original, so the
    // guard must return no ranges rather than corrupt boundaries.
    const text = 'İstanbul reservoir report';
    expect(text.toLowerCase().length).not.toBe(text.length);
    expect(matchRanges(text, ['reservoir'])).toEqual([]);
    expect(highlightMatches(text, ['reservoir'])).toBe(text);
  });
});

describe('highlightMatches', () => {
  it('returns the plain string when nothing matches', () => {
    expect(highlightMatches('untouched text', ['zzz'])).toBe('untouched text');
  });

  it('wraps matches in <mark> nodes and preserves surrounding text', () => {
    const parts = highlightMatches('The reservoir level fell', ['reservoir']) as unknown[];
    expect(Array.isArray(parts)).toBe(true);
    const nodes = parts as Array<string | { type: string; props: { children: string } }>;
    expect(nodes[0]).toBe('The ');
    const mark = nodes[1] as { type: string; props: { children: string } };
    expect(mark.type).toBe('mark');
    expect(mark.props.children).toBe('reservoir');
    expect(nodes[2]).toBe(' level fell');
  });
});
