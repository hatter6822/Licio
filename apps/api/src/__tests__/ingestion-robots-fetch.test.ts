// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.4e/f unit tests — the crawling-discipline layer:
//   • robots.txt parsing + RFC 9309 matching (group selection, longest-rule
//     precedence, Allow-wins-ties, wildcards/anchors, crawl-delay)
//   • the SSRF address gate (every blocked range) and the live fetcher
//     behavior against a real local HTTP server: size caps, redirect caps,
//     redirect-target re-validation, timeouts.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isPathAllowed,
  parseRobotsTxt,
  RobotsCache,
  ruleMatches,
  selectGroup,
} from '../ingestion/robots.js';
import {
  isBlockedAddress,
  isBlockedIpv4,
  isBlockedIpv6,
  safeFetch,
} from '../ingestion/safe-fetch.js';

describe('robots.txt parser + matcher (RFC 9309)', () => {
  const SAMPLE = `# comment
User-agent: liciobot
Disallow: /private/
Allow: /private/press/
Crawl-delay: 2

User-agent: *
Disallow: /tmp/
Disallow: /*.pdf$
`;

  it('parses groups, rules, and crawl-delay', () => {
    const policy = parseRobotsTxt(SAMPLE);
    expect(policy.groups).toHaveLength(2);
    expect(policy.groups[0]?.userAgents).toEqual(['liciobot']);
    expect(policy.groups[0]?.crawlDelaySec).toBe(2);
    expect(policy.groups[1]?.rules).toHaveLength(2);
  });

  it('selects the MOST SPECIFIC user-agent group, falling back to *', () => {
    const policy = parseRobotsTxt(SAMPLE);
    expect(selectGroup(policy, 'LicioBot/1.0 (+https://licio.app/bot)')?.userAgents).toEqual([
      'liciobot',
    ]);
    expect(selectGroup(policy, 'OtherBot/2.0')?.userAgents).toEqual(['*']);
  });

  it('longest matching rule wins; Allow wins a length tie', () => {
    const policy = parseRobotsTxt(SAMPLE);
    expect(isPathAllowed(policy, 'liciobot/1.0', '/private/files/x')).toBe(false);
    // /private/press/ (Allow, longer) beats /private/ (Disallow).
    expect(isPathAllowed(policy, 'liciobot/1.0', '/private/press/release')).toBe(true);
    expect(isPathAllowed(policy, 'liciobot/1.0', '/public/x')).toBe(true);
    const tie = parseRobotsTxt('User-agent: *\nDisallow: /a/\nAllow: /a/*');
    // Same length (4): Allow wins the tie per the RFC.
    expect(isPathAllowed(tie, 'anybot', '/a/x')).toBe(true);
  });

  it('supports * wildcards and $ end anchors', () => {
    expect(ruleMatches('/*.pdf$', '/docs/report.pdf')).toBe(true);
    expect(ruleMatches('/*.pdf$', '/docs/report.pdf?dl=1')).toBe(false);
    expect(ruleMatches('/a*c', '/abc')).toBe(true);
    expect(ruleMatches('/a*c', '/ab')).toBe(false);
    expect(ruleMatches('/exact$', '/exact')).toBe(true);
    expect(ruleMatches('/exact$', '/exactly')).toBe(false);
  });

  it('an empty Disallow allows everything; rules before any group are ignored', () => {
    const policy = parseRobotsTxt('Disallow: /orphan/\nUser-agent: *\nDisallow:');
    expect(isPathAllowed(policy, 'anybot', '/orphan/x')).toBe(true);
    expect(isPathAllowed(policy, 'anybot', '/anything')).toBe(true);
  });

  it('RobotsCache: 404 ⇒ unrestricted; 5xx/network ⇒ fail-closed unreachable; TTL re-fetch', async () => {
    let now = 1_000_000;
    let calls = 0;
    let mode: 'ok' | 'missing' | 'down' = 'ok';
    const cache = new RobotsCache(
      async () => {
        calls += 1;
        if (mode === 'down') return { error: 'network' };
        if (mode === 'missing') return { status: 404, body: '' };
        return { status: 200, body: 'User-agent: *\nDisallow: /no/' };
      },
      () => now,
    );
    const url = new URL('https://cache.example/no/x');
    expect(await cache.check(url, 'liciobot', 60_000)).toEqual({
      allowed: false,
      reason: 'disallowed',
    });
    expect(calls).toBe(1);
    // Cached within TTL.
    await cache.check(url, 'liciobot', 60_000);
    expect(calls).toBe(1);
    // TTL expiry re-fetches; 404 now means no restrictions.
    now += 61_000;
    mode = 'missing';
    expect((await cache.check(url, 'liciobot', 60_000)).allowed).toBe(true);
    // Network failure fails CLOSED (short-cached).
    now += 61_000;
    mode = 'down';
    expect(await cache.check(url, 'liciobot', 60_000)).toEqual({
      allowed: false,
      reason: 'robots_unreachable',
    });
  });

  it('honors crawl-delay: second check within the window reports the wait', async () => {
    let now = 5_000_000;
    const cache = new RobotsCache(
      async () => ({ status: 200, body: 'User-agent: *\nCrawl-delay: 10' }),
      () => now,
    );
    const url = new URL('https://slow.example/a');
    const first = await cache.check(url, 'liciobot', 60_000);
    expect(first).toEqual({ allowed: true, crawlDelaySec: null });
    const second = await cache.check(url, 'liciobot', 60_000);
    expect(second.allowed && second.crawlDelaySec).toBe(10);
    now += 10_000;
    expect(await cache.check(url, 'liciobot', 60_000)).toEqual({
      allowed: true,
      crawlDelaySec: null,
    });
  });
});

describe('SSRF address gate (WS-F.1.4e)', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
  ])('blocks IPv4 %s', (address) => {
    expect(isBlockedIpv4(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '151.101.1.140'])('allows public IPv4 %s', (address) => {
    expect(isBlockedIpv4(address)).toBe(false);
  });

  it.each([
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    // HEX IPv4-mapped forms — the URL parser canonicalises mapped addresses to
    // hex, so these (not the dotted form) are what actually reach the gate.
    '::ffff:7f00:1', // = ::ffff:127.0.0.1 (loopback)
    '::ffff:7f00:0001',
    '::ffff:a00:1', // = ::ffff:10.0.0.1 (RFC 1918)
    '::ffff:a9fe:a9fe', // = ::ffff:169.254.169.254 (cloud metadata)
    '0:0:0:0:0:ffff:7f00:1', // fully-expanded mapped loopback
    // Deprecated IPv4-compatible (`::/96`) forms still route in some stacks.
    '::7f00:1', // = ::127.0.0.1
    '::a9fe:a9fe', // = ::169.254.169.254
  ])('blocks IPv6 %s', (address) => {
    expect(isBlockedIpv6(address)).toBe(true);
  });

  it('allows public IPv6 and routes families correctly', () => {
    expect(isBlockedIpv6('2606:4700::6810:84e5')).toBe(false);
    // A public IPv4 embedded in a mapped address is allowed (the embedded
    // address is what is checked, not the mapping).
    expect(isBlockedIpv6('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIpv6('::ffff:808:808')).toBe(false); // = ::ffff:8.8.8.8 (hex)
    expect(isBlockedAddress('127.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('::1', 6)).toBe(true);
    // An unparseable IPv6 fails closed.
    expect(isBlockedIpv6('not:an:address')).toBe(true);
  });

  it('treats malformed IPv4 as blocked (fail closed)', () => {
    expect(isBlockedIpv4('999.1.1.1')).toBe(true);
    expect(isBlockedIpv4('1.2.3')).toBe(true);
  });
});

describe('safeFetch against a live local server', () => {
  let server: Server;
  let origin = '';
  const LIMITS = { timeoutMs: 3_000, maxBytes: 1_024, maxRedirects: 2, userAgent: 'LicioBot/1.0' };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>hello</body></html>');
      } else if (req.url === '/big') {
        res.writeHead(200);
        res.end('x'.repeat(10_000));
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (req.url === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else if (req.url === '/redirect-ok') {
        res.writeHead(301, { location: '/ok' });
        res.end();
      } else if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200);
          res.end('late');
        }, 10_000);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('refuses loopback literals and the metadata endpoint with the DEFAULT gate (SSRF)', async () => {
    // Port validation fires first for the ephemeral test port…
    expect(await safeFetch(`${origin}/ok`, LIMITS)).toEqual({
      ok: false,
      reason: 'unsupported_port',
    });
    // …and the literal-address gate blocks loopback/metadata on standard ports.
    for (const url of ['http://127.0.0.1/ok', 'http://169.254.169.254/latest/meta-data/']) {
      expect(await safeFetch(url, LIMITS), url).toEqual({
        ok: false,
        reason: 'blocked_address',
        detail: 'literal address blocked',
      });
    }
  });

  it('refuses non-http(s) schemes and non-standard ports', async () => {
    expect((await safeFetch('ftp://example.com/file', LIMITS)).ok).toBe(false);
    expect(await safeFetch('https://example.com:8443/x', LIMITS)).toEqual({
      ok: false,
      reason: 'unsupported_port',
    });
    expect((await safeFetch('not a url', LIMITS)).ok).toBe(false);
  });

  describe('with the loopback-only test gate (the override THROWS in prod)', () => {
    beforeAll(async () => {
      const { __setSsrfPolicyForTesting, isBlockedAddress } = await import(
        '../ingestion/safe-fetch.js'
      );
      // Permit ONLY 127.0.0.1 + the test server's ephemeral port — every
      // other blocked range stays blocked, so the redirect re-validation
      // test below is genuine.
      __setSsrfPolicyForTesting({
        gate: (address, family) => address !== '127.0.0.1' && isBlockedAddress(address, family),
        extraPorts: [new URL(origin).port],
      });
    });

    afterAll(async () => {
      const { __setSsrfPolicyForTesting } = await import('../ingestion/safe-fetch.js');
      __setSsrfPolicyForTesting(null);
    });

    it('fetches a page through the streaming pipeline', async () => {
      const result = await safeFetch(`${origin}/ok`, LIMITS);
      expect(result.ok && result.status).toBe(200);
      expect(result.ok && result.body).toContain('hello');
      expect(result.ok && result.contentType).toContain('text/html');
    });

    it('caps the response size WHILE streaming (never buffers past the limit)', async () => {
      expect(await safeFetch(`${origin}/big`, LIMITS)).toEqual({
        ok: false,
        reason: 'response_too_large',
      });
    });

    it('follows bounded redirects and re-validates EVERY hop', async () => {
      const ok = await safeFetch(`${origin}/redirect-ok`, LIMITS);
      expect(ok.ok && ok.finalUrl).toBe(`${origin}/ok`);
      // A redirect chain that exceeds the cap fails typed.
      expect(await safeFetch(`${origin}/loop`, LIMITS)).toEqual({
        ok: false,
        reason: 'too_many_redirects',
      });
      // A redirect TOWARD the metadata endpoint is blocked at the hop gate —
      // the response from the first hop never reaches a blocked target.
      expect(await safeFetch(`${origin}/to-metadata`, LIMITS)).toEqual({
        ok: false,
        reason: 'blocked_address',
        detail: 'literal address blocked',
      });
    });

    it('enforces the deadline across the WHOLE chain (timeout)', async () => {
      const result = await safeFetch(`${origin}/slow`, { ...LIMITS, timeoutMs: 500 });
      expect(result).toEqual({ ok: false, reason: 'timeout' });
    });
  });
});
