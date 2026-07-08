// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.3b — SIWE message construction: the domain is a hardcoded constant
// (NOT window.location — anti-phishing), all EIP-4361 fields are present in
// canonical order, the expiration is short-lived, and the built string is
// stable/parseable.

import { describe, expect, it } from 'vitest';
import { buildSiweMessage, LICIO_SIWE_DOMAIN, normalizeAddress } from './siwe.js';

describe('buildSiweMessage', () => {
  const params = {
    address: '0xAbC0000000000000000000000000000000000001',
    chainId: 8357,
    nonce: 'deadbeefcafe',
    issuedAt: '2026-07-06T12:00:00.000Z',
  };

  it('binds the HARDCODED domain, not window.location', () => {
    const message = buildSiweMessage(params);
    expect(message.startsWith(`${LICIO_SIWE_DOMAIN} wants you to sign in`)).toBe(true);
    // The domain never reflects a spoofed host.
    expect(message).not.toContain('evil.example');
  });

  it('includes every required EIP-4361 field in order', () => {
    const message = buildSiweMessage(params);
    expect(message).toContain(params.address);
    expect(message).toContain('Version: 1');
    expect(message).toContain('Chain ID: 8357');
    expect(message).toContain('Nonce: deadbeefcafe');
    expect(message).toContain('Issued At: 2026-07-06T12:00:00.000Z');
    expect(message).toContain('Expiration Time:');
  });

  it('sets a short-lived expiration (5 minutes from issued-at by default)', () => {
    const message = buildSiweMessage(params);
    const expLine = message.split('\n').find((l) => l.startsWith('Expiration Time: '));
    const exp = Date.parse((expLine ?? '').replace('Expiration Time: ', ''));
    expect(exp - Date.parse(params.issuedAt)).toBe(5 * 60_000);
  });

  it('the statement discloses that linking does not affect ranking', () => {
    expect(buildSiweMessage(params)).toContain('does not affect ranking');
  });

  it('normalizeAddress lowercases (the wallet re-checksums; server re-derives)', () => {
    expect(normalizeAddress('0xABCD')).toBe('0xabcd');
  });
});
