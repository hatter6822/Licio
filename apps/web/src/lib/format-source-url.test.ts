// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatSourceUrl } from './format-source-url.js';

describe('formatSourceUrl', () => {
  it('splits host + path and strips a leading www.', () => {
    expect(formatSourceUrl('https://www.example.org/reports/2026?id=7')).toEqual({
      host: 'example.org',
      rest: '/reports/2026?id=7',
    });
  });

  it('drops a bare "/" path to an empty tail', () => {
    expect(formatSourceUrl('https://example.gov/')).toEqual({ host: 'example.gov', rest: '' });
    expect(formatSourceUrl('https://example.gov')).toEqual({ host: 'example.gov', rest: '' });
  });

  it('truncates a very long path with an ellipsis', () => {
    const long = `https://example.org/${'a'.repeat(200)}`;
    const { rest } = formatSourceUrl(long);
    expect(rest.endsWith('…')).toBe(true);
    expect(rest.length).toBeLessThanOrEqual(64);
  });

  it('returns the raw string as the host for an unparseable URL', () => {
    expect(formatSourceUrl('not a url')).toEqual({ host: 'not a url', rest: '' });
  });
});
