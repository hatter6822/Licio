// SPDX-License-Identifier: AGPL-3.0-or-later
import { verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  audienceFor,
  buildVapidHeaders,
  generateVapidKeys,
  publicKeyObjectFrom,
  sendWebPush,
  signVapidJwt,
  type VapidConfig,
} from '../lib/vapid.js';

const config = (): VapidConfig => ({ ...generateVapidKeys(), subject: 'mailto:ops@licio.test' });

describe('generateVapidKeys', () => {
  it('produces a 65-byte uncompressed public point and 32-byte private scalar', () => {
    const keys = generateVapidKeys();
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const priv = Buffer.from(keys.privateKey, 'base64url');
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    expect(priv.length).toBe(32);
  });

  it('produces distinct key pairs each call', () => {
    expect(generateVapidKeys().publicKey).not.toBe(generateVapidKeys().publicKey);
  });
});

describe('signVapidJwt', () => {
  it('signs a verifiable ES256 JWT (round-trip with the public key)', () => {
    const c = config();
    const jwt = signVapidJwt({
      audience: 'https://push.example',
      config: c,
      now: 1_700_000_000_000,
    });
    const [headerB64, payloadB64, signatureB64] = jwt.split('.');
    expect(headerB64 && payloadB64 && signatureB64).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerB64 ?? '', 'base64url').toString());
    const payload = JSON.parse(Buffer.from(payloadB64 ?? '', 'base64url').toString());
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(payload.aud).toBe('https://push.example');
    expect(payload.sub).toBe('mailto:ops@licio.test');
    expect(payload.exp).toBe(1_700_000_000 + 12 * 60 * 60);

    const verified = verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicKeyObjectFrom(c.publicKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64 ?? '', 'base64url'),
    );
    expect(verified).toBe(true);
  });

  it('caps the token lifetime at 24h per RFC 8292', () => {
    const c = config();
    const jwt = signVapidJwt({
      audience: 'https://push.example',
      config: c,
      expiresInSeconds: 999_999,
      now: 0,
    });
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
    expect(payload.exp).toBe(24 * 60 * 60);
  });
});

describe('audienceFor + buildVapidHeaders', () => {
  it('derives the audience from the endpoint origin', () => {
    expect(audienceFor('https://fcm.googleapis.com/fcm/send/abc?x=1')).toBe(
      'https://fcm.googleapis.com',
    );
  });

  it('builds a vapid Authorization header carrying the public key', () => {
    const c = config();
    const headers = buildVapidHeaders('https://push.example/sub/1', c);
    expect(headers['Authorization']).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(headers['Authorization']).toContain(`k=${c.publicKey}`);
  });
});

describe('sendWebPush', () => {
  it('posts a bodyless push with VAPID + TTL headers and reports success', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;

    const result = await sendWebPush(
      { endpoint: 'https://push.example/sub/1', keys: { p256dh: 'x', auth: 'y' } },
      config(),
      { fetchImpl: fakeFetch },
    );
    expect(result).toEqual({ ok: true, statusCode: 201, gone: false });
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['TTL']).toBeDefined();
    expect(headers['Content-Length']).toBe('0');
  });

  it('flags a 410 Gone subscription for pruning', async () => {
    const fakeFetch = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
    const result = await sendWebPush(
      { endpoint: 'https://push.example/sub/2', keys: { p256dh: 'x', auth: 'y' } },
      config(),
      { fetchImpl: fakeFetch },
    );
    expect(result.gone).toBe(true);
    expect(result.ok).toBe(false);
  });

  // SSRF: the endpoint is client-registered, so the PRODUCTION transport (no
  // injected fetchImpl) must refuse a private/loopback/link-local or non-https
  // target BEFORE any packet leaves the host — and it must never prune, so a
  // hostile registration can't be distinguished from a live one by the caller.
  it.each([
    ['https://127.0.0.1/x', 'loopback'],
    ['https://10.0.0.5:6379/x', 'RFC 1918'],
    ['https://169.254.169.254/latest/meta-data', 'cloud metadata link-local'],
    ['https://[::1]/x', 'IPv6 loopback'],
    ['http://example.com/x', 'non-https scheme'],
  ])('the default transport blocks a %s endpoint without connecting (%s)', async (endpoint) => {
    const result = await sendWebPush(
      { endpoint, keys: { p256dh: 'x', auth: 'y' } },
      config(),
      // No fetchImpl ⇒ the real SSRF-gated node:https transport, which resolves
      // the literal address synchronously and refuses it (no network I/O).
    );
    expect(result).toEqual({ ok: false, statusCode: 0, gone: false });
  });
});
