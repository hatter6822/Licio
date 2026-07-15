// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2a — the production `CompliancePort.screenAddress` implementation:
// provider seam + verdict cache + case-on-hit.  The provider contract is a
// minimal operator-configured JSON API (documented in docs/compliance/
// README.md): POST {base}/v1/screen {address, context} → {result:
// clear|partial|full}.  The request carries the ADDRESS ONLY — the shipped
// port shape makes the §17.10 "no attention data to chain-analytics
// providers" rule structural, and this module adds nothing to it.
//
// Verdict mapping (fail-closed):
//   clear    → 'clear'   (cached at the full TTL)
//   partial  → 'unavailable' + a sanctions case for manual review (cached at
//              the SHORT TTL — a review may clear it); real-fund paths
//              already reject 'unavailable'.
//   full     → 'blocked' + a critical sanctions case (cached at the full TTL).
//   error/timeout/no provider → 'unavailable' (never cached), alert metric.
import { z } from 'zod';
import type { CompliancePort, SanctionsVerdict } from '../knomosis/ports.js';
import { type CaseDeps, createCase } from './cases.js';
import type { ComplianceRuntimeConfig } from './config.js';
import type { ScreeningCacheStore } from './stores.js';

type Clock = () => number;

/** The provider seam: null ⇒ no provider configured ⇒ 'unavailable'. */
export interface SanctionsProvider {
  screen(input: { addressLower: string; context: string }): Promise<'clear' | 'partial' | 'full'>;
}

const providerResponseSchema = z.object({ result: z.enum(['clear', 'partial', 'full']) }).strict();

/**
 * The operator-configured HTTP provider (env: COMPLIANCE_SCREENING_URL +
 * COMPLIANCE_SCREENING_TOKEN_FILE, all-or-none).  A non-200, malformed body,
 * or timeout THROWS — the service maps every failure to 'unavailable'
 * (fail-closed), never to 'clear'.
 */
export class HttpSanctionsProvider implements SanctionsProvider {
  readonly #baseUrl: string;
  readonly #bearerToken: string;
  readonly #timeoutMs: () => number;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    bearerToken: string;
    timeoutMs: () => number;
    fetchImpl?: typeof fetch;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#bearerToken = options.bearerToken;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async screen(input: {
    addressLower: string;
    context: string;
  }): Promise<'clear' | 'partial' | 'full'> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/screen`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#bearerToken}`,
      },
      body: JSON.stringify({ address: input.addressLower, context: input.context }),
      signal: AbortSignal.timeout(this.#timeoutMs()),
    });
    if (!response.ok) throw new Error(`screening provider returned ${response.status}`);
    const body: unknown = await response.json();
    return providerResponseSchema.parse(body).result;
  }
}

export interface ScreeningDeps {
  provider: SanctionsProvider | null;
  cache: ScreeningCacheStore;
  config: () => ComplianceRuntimeConfig;
  caseDeps: CaseDeps;
  metric: (name: string) => void;
  log: (event: string, meta: Record<string, unknown>) => void;
  alert: (event: string, meta: Record<string, unknown>) => void;
  now: Clock;
}

/** UTC day bucket for idempotent partial/full-match case keys. */
const dayBucket = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function createScreenAddress(deps: ScreeningDeps): CompliancePort['screenAddress'] {
  return async ({ addressLower, deploymentId }): Promise<SanctionsVerdict> => {
    const key = `screen:${deploymentId}:${addressLower}`;
    try {
      const cached = await deps.cache.get(key);
      if (cached === 'clear' || cached === 'blocked' || cached === 'unavailable') {
        deps.metric('compliance.screening.cache_hit');
        return cached;
      }
    } catch {
      // A cache outage is a provider round-trip, never a verdict change.
    }
    if (deps.provider === null) {
      deps.metric('compliance.screening.no_provider');
      return 'unavailable';
    }
    let result: 'clear' | 'partial' | 'full';
    try {
      result = await deps.provider.screen({ addressLower, context: deploymentId });
    } catch (error) {
      deps.metric('compliance.screening.provider_error');
      deps.alert('compliance.screening.provider_error', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      return 'unavailable';
    }
    const config = deps.config();
    if (result === 'clear') {
      deps.metric('compliance.screening.clear');
      await deps.cache.set(key, 'clear', config.screeningCacheTtlMs).catch(() => {});
      return 'clear';
    }
    // A match opens the review case (idempotent per address per day).
    const partial = result === 'partial';
    const opened = await createCase(deps.caseDeps, {
      subjectKind: 'address',
      subjectRef: addressLower,
      triggerType: 'sanctions',
      riskLevel: partial ? 'high' : 'critical',
      note: partial
        ? 'Sanctions screening returned a PARTIAL match; manual review required before the action may proceed.'
        : 'Sanctions screening returned a FULL match; the action was blocked.',
      idempotencyKey: `sanctions:${result}:${addressLower}:${dayBucket(deps.now())}`,
    });
    if (partial) {
      // A partial match is a MAYBE that a human resolves.  The idempotent key
      // means this returns that review once it exists, so honor its outcome:
      // without this the verdict stays `unavailable` until the UTC-day key
      // rolls over and a reviewer literally cannot clear a false positive.
      // (A FULL match is never review-clearable here — it stays blocked.)
      if (
        opened.ok &&
        opened.record.reviewState === 'resolved' &&
        opened.record.resolution?.outcome === 'cleared'
      ) {
        deps.metric('compliance.screening.partial_cleared');
        await deps.cache.set(key, 'clear', config.screeningCacheTtlMs).catch(() => {});
        return 'clear';
      }
      deps.metric('compliance.screening.partial');
      // Short-TTL cache: fail-closed pending review, re-screened soon after.
      await deps.cache.set(key, 'unavailable', config.screeningPartialCacheTtlMs).catch(() => {});
      return 'unavailable';
    }
    deps.metric('compliance.screening.blocked');
    await deps.cache.set(key, 'blocked', config.screeningCacheTtlMs).catch(() => {});
    return 'blocked';
  };
}
