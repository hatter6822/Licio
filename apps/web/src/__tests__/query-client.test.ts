// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../lib/api.js';
import { cachePolicy, createAppQueryClient } from '../lib/query-client.js';

describe('createAppQueryClient', () => {
  it('configures stale-while-revalidate defaults and mutation no-retry', () => {
    const defaults = createAppQueryClient().getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(30_000);
    expect(defaults.queries?.gcTime).toBe(5 * 60_000);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(true);
    expect(defaults.queries?.refetchOnReconnect).toBe(true);
    expect(defaults.mutations?.retry).toBe(false);
  });

  it('retries idempotent failures with exponential backoff up to 3 times', () => {
    const retry = createAppQueryClient().getDefaultOptions().queries?.retry;
    const retryDelay = createAppQueryClient().getDefaultOptions().queries?.retryDelay;
    expect(typeof retry).toBe('function');
    if (typeof retry === 'function') {
      const serverError = new ApiClientError('http_500', 'boom', 500);
      expect(retry(0, serverError)).toBe(true);
      expect(retry(3, serverError)).toBe(false);
    }
    if (typeof retryDelay === 'function') {
      expect(retryDelay(0, new Error())).toBe(1_000);
      expect(retryDelay(1, new Error())).toBe(2_000);
      expect(retryDelay(99, new Error())).toBe(30_000); // capped
    }
  });

  it('does not retry client errors or invalid responses', () => {
    const retry = createAppQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry === 'function') {
      expect(retry(0, new ApiClientError('not_found', 'x', 404))).toBe(false);
      expect(retry(0, new ApiClientError('invalid_response', 'x', 200))).toBe(false);
    }
  });

  it('creates independent instances', () => {
    expect(createAppQueryClient()).not.toBe(createAppQueryClient());
  });
});

describe('cachePolicy', () => {
  it('keeps feature flags always fresh and never cached', () => {
    expect(cachePolicy.featureFlags).toEqual({ staleTime: 0, gcTime: 0 });
  });

  it('gives profile the longest stale time', () => {
    expect(cachePolicy.profile.staleTime).toBeGreaterThan(cachePolicy.feed.staleTime);
  });

  it('keeps the wallet-connection gate always-fresh and polled so a mid-session pause surfaces (N1)', () => {
    // The gate must NOT trust a cached /wallets success while the wallet_connection
    // kill switch is engaged: zero stale/gc time + refetch-on-mount + a short poll
    // guarantee the 503 (failureReason) is surfaced instead of a stale 200.
    expect(cachePolicy.walletGate.staleTime).toBe(0);
    expect(cachePolicy.walletGate.gcTime).toBe(0);
    expect(cachePolicy.walletGate.refetchOnMount).toBe('always');
    expect(cachePolicy.walletGate.refetchInterval).toBeGreaterThan(0);
    // A pause must never be masked for as long as the profile cache would (5 min).
    expect(cachePolicy.walletGate.refetchInterval).toBeLessThan(cachePolicy.profile.staleTime);
  });
});
