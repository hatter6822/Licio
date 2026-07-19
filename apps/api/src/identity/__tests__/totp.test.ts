// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  isReplayedStep,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  TOTP_SECRET_BYTES,
  totp,
  totpStep,
  verifyTotp,
} from '../totp.js';

// RFC 6238 Appendix B seeds (ASCII), one per HMAC algorithm.
const SEED_SHA1 = Buffer.from('12345678901234567890', 'ascii');
const SEED_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii');
const SEED_SHA512 = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
  'ascii',
);

describe('TOTP — RFC 6238 Appendix B test vectors (8-digit)', () => {
  // [unix seconds, sha1, sha256, sha512]
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];

  it.each(vectors)('T=%i', (seconds, sha1, sha256, sha512) => {
    const ms = seconds * 1000;
    expect(totp(SEED_SHA1, ms, 8, 30, 'sha1')).toBe(sha1);
    expect(totp(SEED_SHA256, ms, 8, 30, 'sha256')).toBe(sha256);
    expect(totp(SEED_SHA512, ms, 8, 30, 'sha512')).toBe(sha512);
  });
});

describe('totpStep', () => {
  it('maps T=59s to step 1 (counter 0x...01) per the RFC', () => {
    expect(totpStep(59_000, 30)).toBe(1);
    expect(totpStep(0, 30)).toBe(0);
    expect(totpStep(29_999, 30)).toBe(0);
    expect(totpStep(30_000, 30)).toBe(1);
  });
});

describe('verifyTotp', () => {
  const secret = SEED_SHA1;

  it('accepts the current-step 6-digit code and returns its step', () => {
    const now = 1_700_000_000_000;
    const code = totp(secret, now);
    const result = verifyTotp(secret, code, now);
    expect(result.valid).toBe(true);
    expect(result.step).toBe(totpStep(now));
  });

  it('accepts a code from the previous step (±1 drift window)', () => {
    const now = 1_700_000_000_000;
    const prev = now - 30_000;
    const code = totp(secret, prev);
    expect(verifyTotp(secret, code, now, 1).valid).toBe(true);
  });

  it('rejects a code two steps away (outside the window)', () => {
    const now = 1_700_000_000_000;
    const code = totp(secret, now - 90_000);
    expect(verifyTotp(secret, code, now, 1).valid).toBe(false);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp(secret, '000000', 1_700_000_000_000).valid).toBe(false);
  });

  it('returns the SAME matched step for a replayed code (enabling store-side replay block)', () => {
    const now = 1_700_000_000_000;
    const code = totp(secret, now);
    const first = verifyTotp(secret, code, now);
    const second = verifyTotp(secret, code, now);
    expect(first.step).toBe(second.step);
  });
});

describe('base32 (RFC 4648)', () => {
  it('round-trips arbitrary bytes', () => {
    for (const sample of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      const buf = Buffer.from(sample, 'ascii');
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it('encodes the known vector "foobar"', () => {
    expect(base32Encode(Buffer.from('foobar', 'ascii'))).toBe('MZXW6YTBOI');
  });

  it('rejects an invalid base32 character', () => {
    expect(() => base32Decode('!!!!')).toThrow();
  });
});

describe('generateTotpSecret', () => {
  it('produces a 160-bit (20-byte) secret', () => {
    expect(generateTotpSecret()).toHaveLength(TOTP_SECRET_BYTES);
    expect(generateTotpSecret().equals(generateTotpSecret())).toBe(false);
  });
});

describe('otpauthUri', () => {
  it('builds a valid otpauth URI with issuer Licio', () => {
    const uri = otpauthUri(SEED_SHA1, 'user@example.com');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=Licio');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('hotp default digits', () => {
  it('produces a 6-digit code by default', () => {
    expect(hotp(SEED_SHA1, 0)).toMatch(/^\d{6}$/);
  });
});

describe('recovery codes', () => {
  it('generates the configured count of formatted codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      expect(c).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    }
    // Codes are unique within a set.
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('hashes a recovery code stably and folds confusables on use', () => {
    const [code] = generateRecoveryCodes(1);
    const hash = hashRecoveryCode(code as string);
    expect(hashRecoveryCode(code as string)).toBe(hash);
    // The hyphen is stripped on normalization, so a user omitting it still matches.
    expect(hashRecoveryCode((code as string).replace('-', ''))).toBe(hash);
  });
});

describe('isReplayedStep (forward-only replay gate, WS-D.1.5b)', () => {
  it('accepts the first code (no prior step) and rejects re-use of the same step', () => {
    expect(isReplayedStep(null, 100)).toBe(false); // nothing used yet
    expect(isReplayedStep(100, 100)).toBe(true); // exact re-use
  });

  it('rejects an OLDER still-in-window step after a NEWER one was accepted', () => {
    // The vulnerability: accept step 100, then accept step 101 (a fresh code)
    // — single-step equality memory would now hold 101 and wrongly re-accept a
    // replay of the already-used step 100.  Forward-only rejects step <= 101.
    const highWater = 101;
    expect(isReplayedStep(highWater, 100)).toBe(true); // replay of the older code
    expect(isReplayedStep(highWater, 101)).toBe(true); // replay of the newer code
    expect(isReplayedStep(highWater, 102)).toBe(false); // genuinely newer code
  });
});
