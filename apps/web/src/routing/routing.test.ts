// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  isSafeRedirect,
  isValidUuidParam,
  resolveRouteAccess,
  sanitizeRedirect,
} from './guards.js';
import { parseFeedSearch } from './search.js';

describe('search param parsing', () => {
  it('keeps a valid feed mode and coerces an invalid/absent one to undefined', () => {
    // The front page falls back to the reader's saved mode when the param is absent.
    expect(parseFeedSearch({ mode: 'debates' }).mode).toBe('debates');
    expect(parseFeedSearch({ mode: 'bogus' }).mode).toBeUndefined();
    expect(parseFeedSearch({}).mode).toBeUndefined();
  });

  it('normalizes a legacy shared-URL mode instead of dropping it', () => {
    // Pre-redesign links keep working: the legacy value maps to its canonical
    // successor (chronological → new; the removed modes → best).
    expect(parseFeedSearch({ mode: 'chronological' }).mode).toBe('new');
    expect(parseFeedSearch({ mode: 'balanced' }).mode).toBe('best');
    expect(parseFeedSearch({ mode: 'local' }).mode).toBe('best');
  });
});

describe('resolveRouteAccess (guard table)', () => {
  it('renders an authenticated route with the flag on', () => {
    expect(resolveRouteAccess({ requiresAuth: true, authed: true, flagEnabled: true })).toBe(
      'render',
    );
  });

  it('restricts an authenticated route with the flag off', () => {
    expect(resolveRouteAccess({ requiresAuth: true, authed: true, flagEnabled: false })).toBe(
      'restricted',
    );
  });

  it('redirects an unauthenticated user to login (auth checked before flag)', () => {
    expect(resolveRouteAccess({ requiresAuth: true, authed: false, flagEnabled: false })).toBe(
      'redirect-login',
    );
  });

  it('renders a public, non-flagged route', () => {
    expect(resolveRouteAccess({ requiresAuth: false, authed: false, flagEnabled: null })).toBe(
      'render',
    );
  });

  it('restricts when a flag fails closed (disabled) on a public route', () => {
    expect(resolveRouteAccess({ requiresAuth: false, authed: false, flagEnabled: false })).toBe(
      'restricted',
    );
  });
});

describe('isSafeRedirect (open-redirect defense)', () => {
  it('accepts in-app absolute paths', () => {
    expect(isSafeRedirect('/profile/settings')).toBe(true);
    expect(isSafeRedirect('/stories/abc?mode=chronological')).toBe(true);
  });

  it('rejects off-site and malformed targets', () => {
    expect(isSafeRedirect('//evil.example')).toBe(false);
    expect(isSafeRedirect('https://evil.example')).toBe(false);
    expect(isSafeRedirect('/\\evil.example')).toBe(false);
    expect(isSafeRedirect('relative/path')).toBe(false);
    expect(isSafeRedirect('')).toBe(false);
    expect(isSafeRedirect(undefined)).toBe(false);
    expect(isSafeRedirect('/with\nnewline')).toBe(false);
  });

  it('sanitizeRedirect falls back when the target is unsafe', () => {
    expect(sanitizeRedirect('//evil.example')).toBe('/');
    expect(sanitizeRedirect('/submit')).toBe('/submit');
    expect(sanitizeRedirect(undefined, '/profile')).toBe('/profile');
  });
});

describe('isValidUuidParam', () => {
  it('accepts a uuid and rejects junk', () => {
    expect(isValidUuidParam('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isValidUuidParam('not-a-uuid')).toBe(false);
  });
});
