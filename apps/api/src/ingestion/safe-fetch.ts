// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SSRF-hardened document fetcher (WS-F.1.4e security considerations). Built
// on node:http(s) — NOT global fetch — because the request's `lookup` option
// is the only rebinding-safe place to validate addresses: every name
// resolution (including each redirect hop's) passes through the validator,
// so a DNS answer that changes between "check" and "connect" cannot smuggle
// a private address (TOCTOU/DNS-rebinding defense).
//
// Blocked address space: loopback, RFC 1918 + CGNAT private ranges,
// link-local (incl. the 169.254.169.254 cloud metadata endpoint), multicast,
// reserved, unspecified, IPv6 ULA/link-local, and IPv4-mapped IPv6 forms of
// all of the above. Only http/https on ports 80/443 are ever contacted;
// redirects are capped and re-validated per hop; the response is size-capped
// while STREAMING (not after buffering) and time-capped. The fetched
// document is parsed, never executed.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import {
  guardedLookup,
  ipv6ToBytes,
  isBlockedAddress,
  isBlockedIpv4,
  isBlockedIpv6,
} from '../lib/ssrf-guard.js';

// The SSRF address policy (the block ranges + the rebinding-safe `lookup`
// gate) is shared with the WS-C Web Push delivery leg, so it lives in
// `lib/ssrf-guard.ts`. Re-exported here so existing callers/tests keep
// importing these predicates from the fetcher unchanged.
export { ipv6ToBytes, isBlockedAddress, isBlockedIpv4, isBlockedIpv6 };

// The live gate. NOT configurable in production: the only override path
// throws outside NODE_ENV=test (so the redirect/size/timeout machinery can be
// exercised against a loopback test server without ever shipping a bypass).
let addressGate: (address: string, family: number) => boolean = isBlockedAddress;

/** TEST-ONLY: narrow the gate (e.g. permit 127.0.0.1 for a local server) and
 *  optionally admit an ephemeral test-server port. Throws in any non-test
 *  environment — fail closed by construction. */
export function __setSsrfPolicyForTesting(
  policy: {
    gate?: (address: string, family: number) => boolean;
    extraPorts?: readonly string[];
  } | null,
): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('the SSRF policy is not configurable outside tests');
  }
  addressGate = policy?.gate ?? isBlockedAddress;
  extraAllowedPorts = new Set(policy?.extraPorts ?? []);
}

let extraAllowedPorts: ReadonlySet<string> = new Set();

export interface SafeFetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
}

export type SafeFetchResult =
  | {
      ok: true;
      status: number;
      body: string;
      contentType: string | null;
      finalUrl: string;
    }
  | {
      ok: false;
      reason:
        | 'blocked_address'
        | 'unsupported_scheme'
        | 'unsupported_port'
        | 'too_many_redirects'
        | 'response_too_large'
        | 'timeout'
        | 'network_error'
        | 'bad_redirect';
      detail?: string;
    };

const ALLOWED_PORTS = new Set(['', '80', '443']);

function validateTarget(url: URL): SafeFetchResult | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (!ALLOWED_PORTS.has(url.port) && !extraAllowedPorts.has(url.port)) {
    return { ok: false, reason: 'unsupported_port' };
  }
  // A literal-IP host is validated up front (no DNS step to intercept).
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0 && addressGate(literal, isIP(literal))) {
    return { ok: false, reason: 'blocked_address', detail: 'literal address blocked' };
  }
  return null;
}

/** One HTTP(S) GET with per-resolution address validation + streaming caps. */
function requestOnce(
  url: URL,
  limits: SafeFetchLimits,
  deadlineMs: number,
): Promise<
  | { kind: 'response'; status: number; body: string; contentType: string | null }
  | { kind: 'redirect'; location: string; status: number }
  | { kind: 'error'; result: SafeFetchResult }
> {
  return new Promise((resolve) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (
      value:
        | { kind: 'response'; status: number; body: string; contentType: string | null }
        | { kind: 'redirect'; location: string; status: number }
        | { kind: 'error'; result: SafeFetchResult },
    ) => {
      if (!settled) {
        settled = true;
        if (hardTimer !== undefined) clearTimeout(hardTimer);
        resolve(value);
      }
    };

    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      settle({ kind: 'error', result: { ok: false, reason: 'timeout' } });
      return;
    }

    const request = transport.get(
      url,
      {
        headers: {
          'user-agent': limits.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        },
        timeout: remaining,
        // THE SSRF GATE: every DNS resolution this request performs flows
        // through here — an answer in a blocked range aborts the connection
        // before any packet reaches it (rebinding-safe by construction). The
        // gate closes over the CURRENT `addressGate` so the test override
        // (`__setSsrfPolicyForTesting`) still applies per request.
        lookup: guardedLookup(addressGate),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location !== undefined) {
          // The Location is captured; the redirect body is not needed.  Settle the
          // redirect outcome, then tear the socket down — draining an
          // attacker-controlled (possibly endless or huge) redirect body under NO
          // byte cap would leak the connection and defeat the size limit.
          settle({ kind: 'redirect', location: response.headers.location, status });
          request.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > limits.maxBytes) {
            request.destroy();
            settle({ kind: 'error', result: { ok: false, reason: 'response_too_large' } });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          settle({
            kind: 'response',
            status,
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: response.headers['content-type'] ?? null,
          });
        });
        response.on('error', (error) => {
          settle({
            kind: 'error',
            result: { ok: false, reason: 'network_error', detail: error.message },
          });
        });
      },
    );
    // Wall-clock hard cap on the whole request (connect + streaming body).
    // Unlike the idle socket `timeout` above — which a slow-drip server resets
    // on every byte — this fires after the remaining budget REGARDLESS of
    // activity, enforcing the documented time-capped guarantee on the body read.
    hardTimer = setTimeout(() => {
      settle({ kind: 'error', result: { ok: false, reason: 'timeout' } });
      request.destroy();
    }, remaining);
    request.on('timeout', () => {
      request.destroy();
      settle({ kind: 'error', result: { ok: false, reason: 'timeout' } });
    });
    request.on('error', (error) => {
      const blocked = error.message.includes('blocked address range');
      settle({
        kind: 'error',
        result: blocked
          ? { ok: false, reason: 'blocked_address' }
          : { ok: false, reason: 'network_error', detail: error.message },
      });
    });
  });
}

/**
 * Fetch a document with the full SSRF defense stack. Each redirect hop is
 * re-validated (scheme, port, literal address, and — via the lookup gate —
 * every resolved address).
 */
export async function safeFetch(rawUrl: string, limits: SafeFetchLimits): Promise<SafeFetchResult> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'network_error', detail: 'malformed url' };
  }
  const deadline = Date.now() + limits.timeoutMs;
  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    const invalid = validateTarget(current);
    if (invalid !== null) return invalid;
    const outcome = await requestOnce(current, limits, deadline);
    if (outcome.kind === 'error') return outcome.result;
    if (outcome.kind === 'response') {
      return {
        ok: true,
        status: outcome.status,
        body: outcome.body,
        contentType: outcome.contentType,
        finalUrl: current.toString(),
      };
    }
    try {
      current = new URL(outcome.location, current);
    } catch {
      return { ok: false, reason: 'bad_redirect' };
    }
  }
  return { ok: false, reason: 'too_many_redirects' };
}
