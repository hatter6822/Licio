// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.4f regression pins for the RFC 9309 group selector: a bare
// `User-agent:` line (an empty product token) must never out-rank the `*`
// group.  It used to — `token.includes('')` is always true and `''.length`
// beats the initial best of -1 — so a publisher who disallowed all crawlers
// got fetched anyway, and their `Crawl-delay` was discarded with the group.
import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobotsTxt, RobotsCache, selectGroup } from '../robots.js';

const UA = 'LicioBot/1.0 (+https://licio.app/bot)';

describe('robots.txt: an empty User-agent token never governs (WS-F.1.4f)', () => {
  it('leaves the * group in charge, in either ordering', () => {
    // Both orderings matter: the selector scans groups in document order, so a
    // malformed group before AND after the `*` group has to be inert.
    const before = parseRobotsTxt('User-agent:\nAllow: /\nUser-agent: *\nDisallow: /\n');
    expect(isPathAllowed(before, UA, '/secret')).toBe(false);
    const after = parseRobotsTxt('User-agent: *\nDisallow: /\n\nUser-agent:\nAllow: /\n');
    expect(isPathAllowed(after, UA, '/secret')).toBe(false);
  });

  it('records no agent token for a bare User-agent line', () => {
    const policy = parseRobotsTxt('User-agent:\nAllow: /\n');
    expect(policy.groups.map((g) => g.userAgents)).toEqual([[]]);
    // No group names us and none is `*` ⇒ unrestricted, the RFC's default.
    expect(selectGroup(policy, UA)).toBeNull();
  });

  it('never selects an empty token even in a hand-built policy', () => {
    const wildcard = { userAgents: ['*'], rules: [], crawlDelaySec: 5 };
    const empty = { userAgents: [''], rules: [], crawlDelaySec: null };
    expect(selectGroup({ groups: [empty, wildcard] }, UA)).toBe(wildcard);
  });

  it('keeps the * group Crawl-delay across a trailing bare User-agent line', async () => {
    // `check` calls selectGroup a SECOND time for the delay, so the inversion
    // silently dropped crawl-delay pacing as well as the Disallow rules.
    const body = 'User-agent: *\nCrawl-delay: 2\nDisallow: /admin\n\nUser-agent:\n';
    const now = 1_800_000_000_000;
    const cache = new RobotsCache(
      async () => ({ status: 200, body }),
      () => now,
    );
    expect(await cache.check(new URL('https://ex.test/admin'), UA, 60_000)).toEqual({
      allowed: false,
      reason: 'disallowed',
    });
    // First allowed fetch arms the window; the next one inside it is deferred.
    expect(await cache.check(new URL('https://ex.test/news'), UA, 60_000)).toEqual({
      allowed: true,
      crawlDelaySec: null,
    });
    expect(await cache.check(new URL('https://ex.test/news2'), UA, 60_000)).toEqual({
      allowed: true,
      crawlDelaySec: 2,
    });
  });
});
