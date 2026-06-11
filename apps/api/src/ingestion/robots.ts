// SPDX-License-Identifier: AGPL-3.0-or-later
//
// robots.txt compliance (WS-F.1.4f, SPEC §14.2 "crawling respects robots.txt
// and publisher restrictions"). Parser + matcher follow RFC 9309: group
// selection picks the MOST SPECIFIC matching user-agent (longest token
// match; `*` only when nothing else matches), rule precedence picks the
// LONGEST matching path, and Allow wins a length tie. `$` anchors the end of
// the path; `*` is a wildcard. An UNREACHABLE robots.txt (network error)
// fails CLOSED for crawling — when the rules cannot be read, nothing is
// fetched (publisher restriction posture); a 404 means "no restrictions" per
// the RFC. Results are cached per origin with a TTL.
export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelaySec: number | null;
}

export interface RobotsPolicy {
  groups: RobotsGroup[];
}

/** Parse a robots.txt body (tolerant of comments, casing, BOM, CRLF). */
export function parseRobotsTxt(body: string): RobotsPolicy {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasUserAgent = false;
  for (const rawLine of body.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasUserAgent || current === null) {
        current = { userAgents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.userAgents.push(value.toLowerCase());
      lastWasUserAgent = true;
      continue;
    }
    lastWasUserAgent = false;
    if (current === null) continue; // rules before any user-agent are ignored
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow means "allow everything" (no rule).
      if (value.length === 0) continue;
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed >= 0) current.crawlDelaySec = parsed;
    }
  }
  return { groups };
}

/** The product token of our crawler UA (`LicioBot/1.0 (+…)` → `liciobot`). */
export function productToken(userAgent: string): string {
  return (userAgent.split('/')[0] ?? userAgent).trim().toLowerCase();
}

/** RFC 9309 group selection: most specific user-agent match, `*` fallback. */
export function selectGroup(policy: RobotsPolicy, userAgent: string): RobotsGroup | null {
  const token = productToken(userAgent);
  let best: RobotsGroup | null = null;
  let bestLength = -1;
  let wildcard: RobotsGroup | null = null;
  for (const group of policy.groups) {
    for (const agent of group.userAgents) {
      if (agent === '*') {
        wildcard = wildcard ?? group;
      } else if (token.includes(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }
  return best ?? wildcard;
}

/** Whether a rule path (with `*` wildcards and `$` end anchor) matches. */
export function ruleMatches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith('$');
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath;
  const parts = pattern.split('*');
  let position = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    if (i === 0) {
      if (!path.startsWith(part)) return false;
      position = part.length;
    } else {
      const found = path.indexOf(part, position);
      if (found === -1) return false;
      position = found + part.length;
    }
  }
  if (anchored) {
    // The final literal part must reach the end of the path exactly.
    return parts.length === 1 ? path.length === position : path.endsWith(parts.at(-1) as string);
  }
  return true;
}

/** RFC 9309 decision: longest matching rule wins; Allow wins a length tie. */
export function isPathAllowed(policy: RobotsPolicy, userAgent: string, path: string): boolean {
  const group = selectGroup(policy, userAgent);
  if (group === null) return true; // no applicable group ⇒ unrestricted
  let decision = true;
  let bestLength = -1;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const length = rule.path.length;
    if (length > bestLength || (length === bestLength && rule.allow && !decision)) {
      decision = rule.allow;
      bestLength = length;
    }
  }
  return decision;
}

export type RobotsVerdict =
  | { allowed: true; crawlDelaySec: number | null }
  | { allowed: false; reason: 'disallowed' | 'robots_unreachable' };

/** Fetch `https://origin/robots.txt`; status + body, or a network error. */
export type RobotsFetcher = (
  origin: string,
) => Promise<{ status: number; body: string } | { error: string }>;

interface CacheEntry {
  policy: RobotsPolicy | null; // null ⇒ unreachable (fail-closed) cached too
  expiresAtMs: number;
  /** Earliest next fetch allowed by Crawl-delay (per origin). */
  nextFetchAtMs: number;
}

/**
 * Per-origin robots policy cache with TTL + crawl-delay bookkeeping. One
 * instance per process; the cache is rebuildable state (never persisted).
 */
export class RobotsCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #fetcher: RobotsFetcher;
  readonly #now: () => number;

  constructor(fetcher: RobotsFetcher, now: () => number = Date.now) {
    this.#fetcher = fetcher;
    this.#now = now;
  }

  /**
   * Decide whether `url` may be fetched for `userAgent`. Honors Disallow
   * rules, the per-origin Crawl-delay (a deferred fetch reports `allowed`
   * with the remaining delay via `crawlDelaySec`), the cache TTL, and the
   * fail-closed unreachable posture.
   */
  async check(url: URL, userAgent: string, ttlMs: number): Promise<RobotsVerdict> {
    const origin = url.origin;
    const now = this.#now();
    let entry = this.#entries.get(origin);
    if (!entry || entry.expiresAtMs <= now) {
      const result = await this.#fetcher(origin);
      if ('error' in result) {
        // Unreachable: fail closed, but only cache briefly (1/6 of the TTL)
        // so a transient outage does not pin the origin closed for hours.
        entry = { policy: null, expiresAtMs: now + Math.ceil(ttlMs / 6), nextFetchAtMs: now };
      } else if (result.status >= 400 && result.status < 500) {
        // RFC 9309: 4xx (incl. 404) ⇒ no restrictions.
        entry = { policy: { groups: [] }, expiresAtMs: now + ttlMs, nextFetchAtMs: now };
      } else if (result.status >= 500) {
        // Server error: treat as unreachable (fail closed, short cache).
        entry = { policy: null, expiresAtMs: now + Math.ceil(ttlMs / 6), nextFetchAtMs: now };
      } else {
        entry = {
          policy: parseRobotsTxt(result.body),
          expiresAtMs: now + ttlMs,
          nextFetchAtMs: now,
        };
      }
      this.#entries.set(origin, entry);
    }
    if (entry.policy === null) return { allowed: false, reason: 'robots_unreachable' };
    const path = `${url.pathname}${url.search}`;
    if (!isPathAllowed(entry.policy, userAgent, path)) {
      return { allowed: false, reason: 'disallowed' };
    }
    const group = selectGroup(entry.policy, userAgent);
    const delaySec = group?.crawlDelaySec ?? null;
    if (delaySec !== null && entry.nextFetchAtMs > now) {
      // Within the crawl-delay window: allowed in principle, deferred now.
      return { allowed: true, crawlDelaySec: Math.ceil((entry.nextFetchAtMs - now) / 1_000) };
    }
    if (delaySec !== null) entry.nextFetchAtMs = now + delaySec * 1_000;
    return { allowed: true, crawlDelaySec: null };
  }

  clear(): void {
    this.#entries.clear();
  }
}
