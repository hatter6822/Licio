// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  accountRef,
  constantTimeEqual,
  deriveKey,
  hmacHex,
  KEY_DOMAINS,
  randomToken,
  sessionRef,
  sha256Hex,
  truncateAddress,
} from '../crypto.js';

const SECRET = 'a'.repeat(48);

describe('sha256Hex', () => {
  it('matches the known SHA-256 vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic and 64 hex chars', () => {
    const h = sha256Hex('licio');
    expect(h).toBe(sha256Hex('licio'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deriveKey domain separation', () => {
  it('is deterministic per (secret, domain)', () => {
    expect(deriveKey(SECRET, KEY_DOMAINS.accountRef)).toEqual(
      deriveKey(SECRET, KEY_DOMAINS.accountRef),
    );
  });

  it('yields INDEPENDENT keys across domains (auth-wallet ≠ financial-wallet)', () => {
    const auth = deriveKey(SECRET, KEY_DOMAINS.authWallet);
    const fin = deriveKey(SECRET, KEY_DOMAINS.financialWallet);
    expect(auth.equals(fin)).toBe(false);
    expect(auth).toHaveLength(32);
  });

  it('the SAME address hashes DIFFERENTLY under the two wallet domains', () => {
    const addr = '0xabcDEF0000000000000000000000000000001234';
    const authHash = hmacHex(deriveKey(SECRET, KEY_DOMAINS.authWallet), addr.toLowerCase());
    const finHash = hmacHex(deriveKey(SECRET, KEY_DOMAINS.financialWallet), addr.toLowerCase());
    expect(authHash).not.toBe(finHash);
  });

  it('a different master secret yields a different key', () => {
    expect(
      deriveKey(SECRET, KEY_DOMAINS.accountRef).equals(
        deriveKey('b'.repeat(48), KEY_DOMAINS.accountRef),
      ),
    ).toBe(false);
  });
});

describe('hmacHex', () => {
  it('is deterministic and keyed', () => {
    const k1 = deriveKey(SECRET, KEY_DOMAINS.accountRef);
    expect(hmacHex(k1, 'input-a')).toBe(hmacHex(k1, 'input-a'));
    expect(hmacHex(k1, 'input-a')).not.toBe(hmacHex(k1, 'input-b'));
  });
});

describe('randomToken', () => {
  it('produces non-deterministic hex of the requested byte length', () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(randomToken(16)).toHaveLength(32);
  });
});

describe('constantTimeEqual', () => {
  it('is true for identical strings and false otherwise', () => {
    expect(constantTimeEqual('abcd', 'abcd')).toBe(true);
    expect(constantTimeEqual('abcd', 'abce')).toBe(false);
  });

  it('is false (not throwing) on length mismatch', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('sessionRef', () => {
  it('is a deterministic, short, keyed reference', () => {
    const ref = sessionRef(SECRET, 'a'.repeat(64));
    expect(ref).toHaveLength(12);
    expect(ref).toBe(sessionRef(SECRET, 'a'.repeat(64)));
    expect(ref).not.toBe(sessionRef(SECRET, 'b'.repeat(64)));
  });
});

describe('accountRef', () => {
  it('is case-insensitive (same ref for differently-cased emails)', () => {
    expect(accountRef(SECRET, 'User@Example.com')).toBe(accountRef(SECRET, 'user@example.com'));
  });
});

describe('truncateAddress', () => {
  it('formats long addresses as 0x…tail and passes short ones through', () => {
    expect(truncateAddress('0xabcdef0000000000000000000000000000001234')).toBe('0xabcd…1234');
    expect(truncateAddress('0x1234')).toBe('0x1234');
  });
});
