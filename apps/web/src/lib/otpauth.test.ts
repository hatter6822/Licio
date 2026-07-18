// SPDX-License-Identifier: AGPL-3.0-or-later
//
// otpauth URI helpers (the WS-D TOTP-enrollment presentation forms): parsing,
// the QR-sized compact form (defaults stripped, non-defaults preserved), and
// the grouped setup key.
import { describe, expect, it } from 'vitest';
import { compactOtpauthUri, formatSetupKey, parseOtpauthTotp } from './otpauth.js';

const SECRET = '3NUPKTV5HQPWZBTYKP3CGQMMPHGII7LN';
const FULL = `otpauth://totp/Licio%3Alicio_admin?secret=${SECRET}&issuer=Licio&algorithm=SHA1&digits=6&period=30`;

describe('parseOtpauthTotp', () => {
  it('extracts the secret and the decoded label', () => {
    expect(parseOtpauthTotp(FULL)).toEqual({ secret: SECRET, label: 'Licio:licio_admin' });
  });
  it('rejects non-otpauth URIs, non-totp types, and malformed secrets', () => {
    expect(parseOtpauthTotp('https://totp/x?secret=ABCD')).toBeNull();
    expect(parseOtpauthTotp(`otpauth://hotp/x?secret=${SECRET}`)).toBeNull();
    expect(parseOtpauthTotp('otpauth://totp/x?secret=notbase32!')).toBeNull();
    expect(parseOtpauthTotp('otpauth://totp/x')).toBeNull();
    expect(parseOtpauthTotp('not a uri')).toBeNull();
  });
});

describe('compactOtpauthUri', () => {
  it('strips exactly the spec-default parameters and keeps the rest', () => {
    const compact = compactOtpauthUri(FULL);
    expect(compact).toContain(`secret=${SECRET}`);
    expect(compact).toContain('issuer=Licio');
    expect(compact).not.toContain('algorithm=');
    expect(compact).not.toContain('digits=');
    expect(compact).not.toContain('period=');
    // The compact form stays a valid, equivalent otpauth URI.
    expect(parseOtpauthTotp(compact)).toEqual(parseOtpauthTotp(FULL));
  });
  it('PRESERVES non-default parameters (stripping them would change the codes)', () => {
    const odd = `otpauth://totp/Licio%3Ax?secret=${SECRET}&algorithm=SHA256&digits=8&period=60`;
    const compact = compactOtpauthUri(odd);
    expect(compact).toContain('algorithm=SHA256');
    expect(compact).toContain('digits=8');
    expect(compact).toContain('period=60');
  });
  it('the worst case (30-char handle) fits the v5-L QR capacity of 106 bytes', () => {
    const worst = `otpauth://totp/Licio%3A${'h'.repeat(30)}?secret=${'A'.repeat(32)}&issuer=Licio&algorithm=SHA1&digits=6&period=30`;
    expect(new TextEncoder().encode(compactOtpauthUri(worst)).length).toBeLessThanOrEqual(106);
  });
  it('passes a non-otpauth input through untouched', () => {
    expect(compactOtpauthUri('garbage')).toBe('garbage');
  });
});

describe('formatSetupKey', () => {
  it('groups the key in fours', () => {
    expect(formatSetupKey('ABCDEFGH2345')).toBe('ABCD EFGH 2345');
    expect(formatSetupKey('ABCDE')).toBe('ABCD E');
  });
});
