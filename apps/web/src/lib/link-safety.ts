// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client wallet-drainer link safety (WS-G.4.2c, SPEC §18.5).  Detection is
// the SHARED pure logic (@licio/shared evaluateLinkSafety); this module owns
// the runtime blocklist: fetched from `GET /v1/security/link-blocklist`
// (steward-updatable without an app deploy), cached in memory with a
// version-keyed TTL so updates propagate within minutes and a cold cache
// fails CLOSED to heuristics-only (never blocks rendering, only adds the
// interstitial).  The user's continue/back choice is never reported with
// their identity — only an anonymous counter event.
import {
  evaluateLinkSafety,
  type LinkSafetyVerdict,
  linkBlocklistResponseSchema,
} from '@licio/shared';
import { track } from './telemetry.js';

const BLOCKLIST_TTL_MS = 5 * 60_000;

interface BlocklistCache {
  domains: readonly string[];
  version: string;
  fetchedAt: number;
}

let cache: BlocklistCache | null = null;
let inFlight: Promise<BlocklistCache> | null = null;

async function fetchBlocklist(): Promise<BlocklistCache> {
  const response = await fetch('/v1/security/link-blocklist', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`blocklist fetch failed: ${response.status}`);
  const parsed = linkBlocklistResponseSchema.parse((await response.json()) as unknown);
  return { domains: parsed.domains, version: parsed.version, fetchedAt: Date.now() };
}

/** The current blocklist (cached; empty on fetch failure — heuristics still run). */
export async function currentBlocklist(now: number = Date.now()): Promise<readonly string[]> {
  if (cache && now - cache.fetchedAt < BLOCKLIST_TTL_MS) return cache.domains;
  inFlight ??= fetchBlocklist()
    .then((fresh) => {
      cache = fresh;
      return fresh;
    })
    .finally(() => {
      inFlight = null;
    });
  try {
    return (await inFlight).domains;
  } catch {
    return cache?.domains ?? [];
  }
}

/**
 * The blocklist available RIGHT NOW, without ever awaiting the network: the
 * cache (fresh or stale) is returned synchronously, and a stale/cold cache
 * triggers a BACKGROUND refresh for the next call.  This is what the click
 * path uses — a verdict must never suspend past the browser's transient
 * user-activation window, or `window.open` gets popup-blocked.  A cold
 * cache degrades to heuristics-only for that one click (the heuristics are
 * pure and local), which `warmLinkSafety()` at bootstrap makes rare.
 */
export function cachedBlocklist(now: number = Date.now()): readonly string[] {
  if (!cache || now - cache.fetchedAt >= BLOCKLIST_TTL_MS) {
    void currentBlocklist(now).catch(() => {});
  }
  return cache?.domains ?? [];
}

/** Bootstrap warm-up: fetch the blocklist before the first link click. */
export async function warmLinkSafety(): Promise<void> {
  await currentBlocklist().catch(() => {});
}

/**
 * Evaluate a URL for the interstitial decision (WS-G.4.2c).  Resolves in a
 * microtask — never a network round-trip (see `cachedBlocklist`).
 */
export async function checkLinkSafety(url: string): Promise<LinkSafetyVerdict> {
  const verdict = evaluateLinkSafety(url, cachedBlocklist());
  if (verdict.suspicious) {
    // Anonymous counter only — never the user, never the destination host
    // beyond the coarse reason (§18.5 "not associated with their identity").
    track({ name: 'interaction', metric: 'link-interstitial', value: 1 });
  }
  return verdict;
}

/** Test seam. */
export function resetLinkSafetyCacheForTests(): void {
  cache = null;
  inFlight = null;
}
