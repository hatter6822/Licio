// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Safety pre-checks (WS-F.1.4c, SPEC §18.2 automated pre-checks / §25.5 /
// §19.1). Identity-free by construction: the submission rate limiter is a
// per-account sliding window keyed by the NON-REVERSIBLE account ref (the
// WS-E limiter pattern with hour+day windows); account age comes from the
// account record; spam patterns are content-keyed (normalized-title counts);
// the malware/phishing check is a LOCALLY-MAINTAINED domain denylist — no
// external scanning API ever sees a submitted URL (§19.1: even Google Safe
// Browsing would leak the platform's content interests). The provider seam
// stays: if an external check were ever approved by privacy review, an
// unavailable provider HOLDS link stories for review (fail toward caution),
// never silently allows.
import { createHash } from 'node:crypto';
import { type SlidingWindowStore, slidingWindowRetryAfterMs } from '../events/ingest-limiter.js';

export interface SubmissionLimits {
  perHour: number;
  perDay: number;
}

export interface SubmissionRateDecision {
  allowed: boolean;
  retryAfterSec: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Hour+day sliding-window submission limiter (WS-F.1.4c: default 10/h,
 * 50/d). Retry-After uses the exact k-th-oldest formula from the WS-E
 * limiter: the wait until enough entries age out of the violated window.
 */
export class SubmissionRateLimiter {
  readonly #store: SlidingWindowStore;

  constructor(store: SlidingWindowStore) {
    this.#store = store;
  }

  async hit(
    accountRef: string,
    limits: SubmissionLimits,
    now: number,
  ): Promise<SubmissionRateDecision> {
    const hourCount = await this.#store.hit(`sub:${accountRef}:h`, now, HOUR_MS);
    const dayCount = await this.#store.hit(`sub:${accountRef}:d`, now, DAY_MS);
    const violated: Array<{ key: string; windowMs: number; count: number; limit: number }> = [];
    if (hourCount > limits.perHour) {
      violated.push({
        key: `sub:${accountRef}:h`,
        windowMs: HOUR_MS,
        count: hourCount,
        limit: limits.perHour,
      });
    }
    if (dayCount > limits.perDay) {
      violated.push({
        key: `sub:${accountRef}:d`,
        windowMs: DAY_MS,
        count: dayCount,
        limit: limits.perDay,
      });
    }
    if (violated.length === 0) return { allowed: true, retryAfterSec: 0 };
    const retryAfterMs = await slidingWindowRetryAfterMs(this.#store, now, violated);
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1_000) };
  }
}

/** Normalized-title hash (spam pattern key, WS-F.1.4c). */
export function titleHash(title: string): string {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export type UrlSafetyVerdict = 'safe' | 'malicious' | 'unavailable';

/** The URL-safety seam (WS-F.1.4c): default is the local domain denylist. */
export interface UrlSafetyProvider {
  check(canonicalDomain: string): Promise<UrlSafetyVerdict>;
}

/**
 * Locally-maintained denylist provider: matches the domain and every parent
 * domain (a denylisted `evil.example` blocks `cdn.evil.example` too). Always
 * available — `unavailable` (→ hold-for-review) exists for future external
 * providers behind the same seam.
 */
export class LocalDenylistUrlSafety implements UrlSafetyProvider {
  readonly #domains: () => readonly string[];

  constructor(domains: () => readonly string[]) {
    this.#domains = domains;
  }

  async check(canonicalDomain: string): Promise<UrlSafetyVerdict> {
    const denied = new Set(this.#domains().map((d) => d.toLowerCase()));
    const labels = canonicalDomain.toLowerCase().split('.');
    for (let i = 0; i < labels.length - 1; i += 1) {
      if (denied.has(labels.slice(i).join('.'))) return 'malicious';
    }
    return 'safe';
  }
}

export type PrecheckRejection =
  | { code: 'account_too_new'; waitMinutes: number }
  | { code: 'duplicate_title_spam' }
  | { code: 'malicious_url' }
  | { code: 'url_safety_unavailable_hold' };

export interface PrecheckInputs {
  accountCreatedAtIso: string;
  nowMs: number;
  minAccountAgeMinutes: number;
  /** Identical-title submissions already seen in the window (store count). */
  duplicateTitleCount: number;
  duplicateTitleLimit: number;
  /** Canonical domain for link stories; null for other types. */
  canonicalDomain: string | null;
  urlVerdict: UrlSafetyVerdict | null;
}

/**
 * The pure pre-check decision (WS-F.1.4c): account age → spam title pattern
 * → URL safety. Returns the FIRST rejection or null when clear.
 */
export function evaluatePrechecks(inputs: PrecheckInputs): PrecheckRejection | null {
  const ageMinutes = (inputs.nowMs - Date.parse(inputs.accountCreatedAtIso)) / 60_000;
  if (ageMinutes < inputs.minAccountAgeMinutes) {
    return {
      code: 'account_too_new',
      waitMinutes: Math.ceil(inputs.minAccountAgeMinutes - ageMinutes),
    };
  }
  if (inputs.duplicateTitleCount >= inputs.duplicateTitleLimit) {
    return { code: 'duplicate_title_spam' };
  }
  if (inputs.canonicalDomain !== null) {
    if (inputs.urlVerdict === 'malicious') return { code: 'malicious_url' };
    if (inputs.urlVerdict === 'unavailable') return { code: 'url_safety_unavailable_hold' };
  }
  return null;
}
