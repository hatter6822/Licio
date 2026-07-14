// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VAPID (RFC 8292) for Web Push (WS-C.2.4a). Implemented with Node's built-in
// `crypto` — no third-party push library — so the dependency surface stays
// minimal (SPEC dependency doctrine). The PRIVATE key never leaves the server:
// only the public key is exposed to the client (verified by bundle inspection,
// SPEC §6.8/§21.2). Notifications are sent as bodyless "tickles" (no encrypted
// payload), so a push carries NO sensitive content (SPEC §6.7); the service
// worker fetches the actual, minimal notification text after waking.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import https from 'node:https';
import { isIP } from 'node:net';
import type { PushSubscriptionJson } from '@licio/shared';
import { guardedLookup, isBlockedAddress } from './ssrf-guard.js';

export interface VapidKeys {
  /** base64url uncompressed P-256 point (65 bytes: 0x04 ‖ X ‖ Y). */
  publicKey: string;
  /** base64url raw P-256 private scalar d (32 bytes). */
  privateKey: string;
}

export interface VapidConfig extends VapidKeys {
  /** Contact URI: `mailto:` or `https://` (RFC 8292 §2.1 `sub`). */
  subject: string;
}

/** Left-pad a buffer to `length` bytes (JWK coordinates must be fixed-width). */
function padLeft(buffer: Buffer, length: number): Buffer {
  if (buffer.length >= length) return buffer.subarray(buffer.length - length);
  const out = Buffer.alloc(length);
  buffer.copy(out, length - buffer.length);
  return out;
}

/**
 * Generate a fresh VAPID key pair. Used by the ops key-generation script; the
 * keys are then provided to the server via env (never committed, never bundled).
 */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const x = padLeft(Buffer.from(pubJwk.x ?? '', 'base64url'), 32);
  const y = padLeft(Buffer.from(pubJwk.y ?? '', 'base64url'), 32);
  const d = padLeft(Buffer.from(privJwk.d ?? '', 'base64url'), 32);
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
  return {
    publicKey: uncompressed.toString('base64url'),
    privateKey: d.toString('base64url'),
  };
}

/** Reconstruct an EC private KeyObject from the base64url public point + scalar. */
function privateKeyFrom(keys: VapidKeys): ReturnType<typeof createPrivateKey> {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
      d: keys.privateKey,
    },
  });
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export interface SignVapidJwtOptions {
  audience: string;
  config: VapidConfig;
  /** Token lifetime; RFC 8292 caps at 24h. Defaults to 12h. */
  expiresInSeconds?: number;
  /** Injected clock for deterministic tests. */
  now?: number;
}

/**
 * Produce a signed ES256 VAPID JWT for the `Authorization` header. The signature
 * is IEEE-P1363 (raw R‖S, 64 bytes) as required by JOSE ES256, not DER.
 */
export function signVapidJwt(options: SignVapidJwtOptions): string {
  const { audience, config, expiresInSeconds = 12 * 60 * 60, now = Date.now() } = options;
  const issuedAtSeconds = Math.floor(now / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: issuedAtSeconds + Math.min(expiresInSeconds, 24 * 60 * 60),
    sub: config.subject,
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: privateKeyFrom(config),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** The `aud` for a subscription is the scheme+host (origin) of its endpoint. */
export function audienceFor(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/** Build the VAPID `Authorization` header for a push to `endpoint`. */
export function buildVapidHeaders(endpoint: string, config: VapidConfig): Record<string, string> {
  const jwt = signVapidJwt({ audience: audienceFor(endpoint), config });
  return { Authorization: `vapid t=${jwt}, k=${config.publicKey}` };
}

export interface SendPushResult {
  ok: boolean;
  statusCode: number;
  /** Subscription is permanently gone (404/410) and should be pruned. */
  gone: boolean;
}

/** How long a bodyless push POST may take before we give up (delivery is
 *  best-effort — a slow push service must not tie up a worker). */
const PUSH_TIMEOUT_MS = 10_000;

/**
 * The PRODUCTION transport: a bodyless `https:` POST whose DNS resolution is
 * gated by the shared SSRF policy (`lib/ssrf-guard.ts`). The `endpoint` is a
 * value the CLIENT registered, so — exactly like a user-submitted link — it
 * must never let the API reach a private/loopback/link-local address. Built on
 * `node:https` rather than `fetch` because the `lookup` option is the only
 * rebinding-safe place to validate the resolved address (the address checked
 * is the address dialed). A blocked address / connection error resolves to a
 * non-`ok`, non-`gone` result: delivery failed, but the subscription is NOT
 * pruned (a transient network fault must not drop a legitimate subscription).
 */
function guardedPushPost(
  endpoint: string,
  headers: Record<string, string>,
  requestImpl: typeof https.request = https.request,
): Promise<SendPushResult> {
  const failed: SendPushResult = { ok: false, statusCode: 0, gone: false };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return Promise.resolve(failed);
  }
  // Defense in depth with the schema `https:` refinement + a literal-IP host
  // pre-check (no DNS step to intercept for a bare address).
  if (url.protocol !== 'https:') return Promise.resolve(failed);
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(literal);
  if (literalFamily !== 0 && isBlockedAddress(literal, literalFamily)) {
    return Promise.resolve(failed);
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: SendPushResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = requestImpl(
      url,
      { method: 'POST', headers, timeout: PUSH_TIMEOUT_MS, lookup: guardedLookup() },
      (response) => {
        response.resume(); // drain — the push is bodyless, we read no payload back
        const status = response.statusCode ?? 0;
        response.on('end', () =>
          settle({
            ok: status >= 200 && status < 300,
            statusCode: status,
            gone: status === 404 || status === 410,
          }),
        );
        // A client-registered host can send headers then reset before the body
        // completes — that emits `error` (or `aborted`) on the RESPONSE, not the
        // request. Without these listeners the stream error is unhandled and can
        // crash the API during delivery. Settle to `failed` (no prune) instead.
        response.on('error', () => settle(failed));
        response.on('aborted', () => settle(failed));
      },
    );
    request.on('timeout', () => {
      request.destroy();
      settle(failed);
    });
    request.on('error', () => settle(failed));
    request.end();
  });
}

/**
 * Send a bodyless Web Push to one subscription. Carries no payload — the push is
 * a wake signal only (privacy: no sensitive content on the wire). Returns the
 * delivery outcome; a 404/410 marks the subscription stale for pruning
 * (WS-C.2.4a observability).
 *
 * Production uses the SSRF-gated `node:https` transport above. An injected
 * `fetchImpl` (tests) owns its own transport and bypasses the gate — the gate's
 * purpose is to constrain what the SERVER dials on the real network.
 * `requestImpl` is a test-only seam to exercise the guarded `node:https`
 * transport's response/stream-error handling without real TLS.
 */
export async function sendWebPush(
  subscription: PushSubscriptionJson,
  config: VapidConfig,
  options: {
    ttlSeconds?: number;
    fetchImpl?: typeof fetch;
    requestImpl?: typeof https.request;
  } = {},
): Promise<SendPushResult> {
  const { ttlSeconds = 28 * 24 * 60 * 60, fetchImpl, requestImpl } = options;
  const headers = {
    ...buildVapidHeaders(subscription.endpoint, config),
    TTL: String(ttlSeconds),
    'Content-Length': '0',
  };
  if (fetchImpl === undefined) {
    return guardedPushPost(subscription.endpoint, headers, requestImpl);
  }
  const response = await fetchImpl(subscription.endpoint, { method: 'POST', headers });
  return {
    ok: response.ok,
    statusCode: response.status,
    gone: response.status === 404 || response.status === 410,
  };
}

/** Verify a public KeyObject can be derived (used by setup tooling/tests). */
export function publicKeyObjectFrom(publicKeyB64: string): ReturnType<typeof createPublicKey> {
  const pub = Buffer.from(publicKeyB64, 'base64url');
  return createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
  });
}
