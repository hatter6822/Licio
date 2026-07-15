// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1a/e — active-policy resolution with the hot-reload cache.  The
// LATEST effective row for a region is validated through the shared
// `validatePolicy` on every cache fill; a nonconforming latest row makes the
// REGION policy-missing (fail-closed) — never a silent fallback to an older,
// possibly more permissive version, and never a partially-honored document.
//
// Cache: per-region TTL'd entries (the `compliance.policyCacheTtlMs` bound on
// hot-reload latency) plus cross-instance invalidation over the broadcaster
// (Redis pub/sub in production, in-process loopback in dev/tests) so no
// instance serves a stale policy past a force-refresh.
import { type JurisdictionFeaturePolicy, validatePolicy } from '@licio/shared';
import type { JurisdictionPolicyStore, PolicyInvalidationBroadcaster } from './stores.js';

type Clock = () => number;

export type ActivePolicyOutcome =
  | { kind: 'active'; policy: JurisdictionFeaturePolicy }
  | { kind: 'missing' }
  | { kind: 'future_dated' }
  | { kind: 'malformed' }
  | { kind: 'store_unavailable' };

interface CacheEntry {
  outcome: ActivePolicyOutcome;
  expiresAt: number;
}

export class PolicyCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #ttlMs: () => number;
  readonly #now: Clock;

  constructor(ttlMs: () => number, now: Clock) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get(region: string): ActivePolicyOutcome | null {
    const entry = this.#entries.get(region);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(region);
      return null;
    }
    return entry.outcome;
  }

  set(region: string, outcome: ActivePolicyOutcome): void {
    // A store outage is never cached: the next call re-probes the store.
    if (outcome.kind === 'store_unavailable') return;
    this.#entries.set(region, { outcome, expiresAt: this.#now() + this.#ttlMs() });
  }

  invalidate(region: string | null): void {
    if (region === null) this.#entries.clear();
    else this.#entries.delete(region);
  }
}

export interface ActivePolicyDeps {
  policies: JurisdictionPolicyStore;
  cache: PolicyCache;
  now: Clock;
  /** Invalid stored rows are REPORTED (observability), then treated as absent. */
  onMalformed: (region: string, policyId: string, problems: string[]) => void;
}

/**
 * Resolve the active policy for a region (WS-N.1.1c input).  Outcomes are
 * exhaustive so the engine can map each to its precise disable reason:
 * `missing`, `future_dated` (rows exist, none effective), `malformed`
 * (latest effective row fails WS-N.1.1a-2 — treated as absent), and
 * `store_unavailable` (fail-closed, never cached).
 */
export async function activePolicyForRegion(
  deps: ActivePolicyDeps,
  region: string,
): Promise<ActivePolicyOutcome> {
  const cached = deps.cache.get(region);
  if (cached !== null) return cached;
  let outcome: ActivePolicyOutcome;
  try {
    const nowIso = new Date(deps.now()).toISOString();
    const row = await deps.policies.activeForRegion(region, nowIso);
    if (row === null) {
      outcome = (await deps.policies.hasOnlyFutureRows(region, nowIso))
        ? { kind: 'future_dated' }
        : { kind: 'missing' };
    } else {
      const validated = validatePolicy(row.document);
      if (validated.ok) {
        outcome = { kind: 'active', policy: validated.policy };
      } else {
        deps.onMalformed(
          region,
          row.policyId,
          validated.problems.map((p) => `${p.path}: ${p.problem}`),
        );
        outcome = { kind: 'malformed' };
      }
    }
  } catch {
    return { kind: 'store_unavailable' };
  }
  deps.cache.set(region, outcome);
  return outcome;
}

/** Wire the broadcaster into the cache (boot): remote invalidations land here. */
export function bindPolicyInvalidation(
  broadcaster: PolicyInvalidationBroadcaster,
  cache: PolicyCache,
): void {
  broadcaster.subscribe((region) => cache.invalidate(region));
}
