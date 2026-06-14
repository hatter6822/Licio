// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.2c — signed media read URLs. A token must be unforgeable, bound to its
// upload id, and reject anything expired or tampered; the public/restricted path
// builders must round-trip through verification.
import { describe, expect, it } from 'vitest';
import {
  MEDIA_URL_TTL_MS,
  makeMediaUrlMinter,
  mediaUrlPath,
  signedMediaUrlPath,
  signMediaToken,
  verifyMediaToken,
} from '../lib/media-urls.js';

const SECRET = 'test-master-secret-0123456789';
const UPLOAD = '550e8400-e29b-41d4-a716-446655440000';

describe('signMediaToken', () => {
  it('is deterministic for the same (secret, upload, expiry)', () => {
    expect(signMediaToken(SECRET, UPLOAD, 1_000)).toBe(signMediaToken(SECRET, UPLOAD, 1_000));
  });

  it('changes with the upload id, the expiry, and the secret', () => {
    const base = signMediaToken(SECRET, UPLOAD, 1_000);
    expect(signMediaToken(SECRET, 'other-upload', 1_000)).not.toBe(base);
    expect(signMediaToken(SECRET, UPLOAD, 2_000)).not.toBe(base);
    expect(signMediaToken('other-secret', UPLOAD, 1_000)).not.toBe(base);
  });
});

describe('verifyMediaToken', () => {
  const exp = 10_000;
  const sig = signMediaToken(SECRET, UPLOAD, exp);

  it('accepts a valid, unexpired token', () => {
    expect(verifyMediaToken(SECRET, UPLOAD, exp, sig, 9_999)).toBe(true);
  });

  it('rejects an expired token (now >= expiry)', () => {
    expect(verifyMediaToken(SECRET, UPLOAD, exp, sig, exp)).toBe(false);
    expect(verifyMediaToken(SECRET, UPLOAD, exp, sig, exp + 1)).toBe(false);
  });

  it('rejects a tampered signature, a rebound upload id, and a wrong secret', () => {
    expect(verifyMediaToken(SECRET, UPLOAD, exp, `${sig}00`, 0)).toBe(false);
    expect(verifyMediaToken(SECRET, 'other-upload', exp, sig, 0)).toBe(false);
    expect(verifyMediaToken('other-secret', UPLOAD, exp, sig, 0)).toBe(false);
  });

  it('rejects a non-finite / empty expiry or signature', () => {
    expect(verifyMediaToken(SECRET, UPLOAD, Number.NaN, sig, 0)).toBe(false);
    expect(verifyMediaToken(SECRET, UPLOAD, exp, '', 0)).toBe(false);
  });
});

describe('URL path builders', () => {
  it('mediaUrlPath is a bare same-origin uploads path', () => {
    expect(mediaUrlPath(UPLOAD)).toBe(`/v1/uploads/${UPLOAD}`);
  });

  it('signedMediaUrlPath round-trips through verifyMediaToken at the bound id', () => {
    const now = 1_000;
    const url = signedMediaUrlPath(SECRET, UPLOAD, now);
    const params = new URL(url, 'http://local').searchParams;
    const e = Number(params.get('e'));
    const t = params.get('t') ?? '';
    expect(e).toBe(now + MEDIA_URL_TTL_MS);
    expect(verifyMediaToken(SECRET, UPLOAD, e, t, now)).toBe(true);
    // Bound to THIS upload id: the same token does not authorize another upload.
    expect(verifyMediaToken(SECRET, 'other-upload', e, t, now)).toBe(false);
  });

  it('makeMediaUrlMinter returns a bare path for public (unrestricted) media', () => {
    // The public branch never reads the identity service (lazy secret access).
    expect(makeMediaUrlMinter(1_000)(UPLOAD, false)).toBe(`/v1/uploads/${UPLOAD}`);
  });
});
