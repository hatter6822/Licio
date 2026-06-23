// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a/b — `assertPrivateBundleTrusted()`: the runtime verify-BEFORE-unlock
// chokepoint (PRIVATE_SPEC §20.6, §22.4; WS-O.3.2e).  The trusted app bootstrap
// calls this BEFORE loading the private-p2p engine / unlocking any room key.  It:
//
//   1. resolves + hashes the RUNNING private-mode chunk bytes (bundle-digest.ts),
//   2. fetches the signed update manifest (same-origin),
//   3. runs the PURE `verifyUpdateManifest` from `@licio/shared` against the
//      build-pinned (or rotated) signer set + transparency-log key,
//   4. caches + publishes the verdict.
//
// On ANY untrusted verdict — unsigned, untrusted signer, digest mismatch, not in
// the transparency log, stale, or any read/parse/crypto failure — it returns
// `{ trusted: false, reason }`.  The private-room surface MUST consult
// `isPrivateBundleLocked()` / the verdict and LOCK (keys stay sealed) with the
// exact §20.6 copy on a lock.  This module owns the verdict + the lock-state
// store; it performs no key unlock and no SW mutation itself (those are the
// engine caller and `sw-pinning.ts`).

import {
  decideUpdateActivation,
  PRIVATE_BUNDLE_LOCK_MESSAGE,
  type TrustedBundleVerdict,
  type UpdateUntrustedReason,
  verifyUpdateManifest,
} from '@licio/shared';
import { recordTrustedSequence } from './anti-rollback.js';
import { computeRunningBundleDigest, discoverPrivateBundleUrl } from './bundle-digest.js';
import {
  loadUpdateChannelConfig,
  UPDATE_MANIFEST_PATH,
  type UpdateChannelConfig,
} from './config.js';

/** The published gate state the UI / engine caller consults. */
export interface PrivateBundleGateState {
  /** `'checking'` before the first verdict; then the verdict outcome. */
  readonly status: 'checking' | 'trusted' | 'locked';
  /** The untrusted reason when `status === 'locked'`. */
  readonly reason?: UpdateUntrustedReason;
  /** The exact §20.6 lock copy when locked (for the UI to render verbatim). */
  readonly message?: string;
  /** The verified release sequence when trusted (for anti-rollback bookkeeping). */
  readonly releaseSequence?: number;
}

const INITIAL: PrivateBundleGateState = { status: 'checking' };

let current: PrivateBundleGateState = INITIAL;
let inflight: Promise<TrustedBundleVerdict> | undefined;
const listeners = new Set<(s: PrivateBundleGateState) => void>();

function publish(next: PrivateBundleGateState): void {
  current = next;
  for (const listener of listeners) listener(next);
}

/** Subscribe to gate-state changes; returns an unsubscribe fn. */
export function subscribePrivateBundleGate(
  listener: (s: PrivateBundleGateState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current gate state (synchronous snapshot). */
export function privateBundleGateState(): PrivateBundleGateState {
  return current;
}

/** Whether private rooms are LOCKED (anything other than a `trusted` verdict). */
export function isPrivateBundleLocked(): boolean {
  return current.status !== 'trusted';
}

/** Map a verdict to the published gate state (uses the §20.6 copy on a lock). */
function verdictToState(verdict: TrustedBundleVerdict): PrivateBundleGateState {
  const decision = decideUpdateActivation(verdict);
  if (decision.action === 'activate') {
    return { status: 'trusted', releaseSequence: decision.releaseSequence };
  }
  return { status: 'locked', reason: decision.reason, message: PRIVATE_BUNDLE_LOCK_MESSAGE };
}

/** Dependencies the verification needs (injectable for tests). */
export interface AssertTrustedDeps {
  readonly config?: UpdateChannelConfig;
  readonly fetchImpl?: typeof fetch;
  /** Resolve the running private-mode chunk URL (default: DOM discovery). */
  readonly resolveBundleUrl?: () => string | undefined;
}

async function fetchManifest(fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(UPDATE_MANIFEST_PATH, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`update manifest fetch failed: ${res.status}`);
  return (await res.json()) as unknown;
}

/**
 * Verify the running private-mode bundle and publish the gate state.  Pure
 * orchestration over the shared verifier; fail-closed at every step.  Memoized
 * per process (call `resetPrivateBundleGate()` to force a re-check, e.g. after a
 * rotated-signer recovery).
 */
export async function assertPrivateBundleTrusted(
  deps: AssertTrustedDeps = {},
): Promise<TrustedBundleVerdict> {
  if (inflight) return inflight;
  const run = (async (): Promise<TrustedBundleVerdict> => {
    const config = deps.config ?? loadUpdateChannelConfig();
    const fetchImpl = deps.fetchImpl ?? fetch;
    const resolveUrl = deps.resolveBundleUrl ?? (() => discoverPrivateBundleUrl());
    let verdict: TrustedBundleVerdict;
    try {
      const bundleUrl = resolveUrl();
      if (!bundleUrl) {
        // Cannot locate the running chunk ⇒ cannot prove its digest ⇒ lock.
        verdict = { trusted: false, reason: 'digest_mismatch' };
      } else {
        const runningBundleDigest = await computeRunningBundleDigest(bundleUrl, fetchImpl);
        const manifest = await fetchManifest(fetchImpl);
        verdict = await verifyUpdateManifest({
          manifest,
          runningBundleDigest,
          trustedSignerPublicKeys: config.trustedSignerPublicKeys,
          logPublicKey: config.logPublicKey,
          ...(config.lastTrustedSequence !== undefined
            ? { lastTrustedSequence: config.lastTrustedSequence }
            : {}),
        });
      }
    } catch {
      // A network/parse/crypto failure is UNTRUSTED, never a soft pass (§20.6
      // "a log/network read failure is untrusted (fail-closed)").
      verdict = { trusted: false, reason: 'not_in_transparency_log' };
    }
    // Anti-rollback (§27.5): persist the trusted release sequence as the new
    // floor (monotonic) so a later validly-signed OLDER bundle is `stale`.
    if (verdict.trusted) recordTrustedSequence(verdict.releaseSequence);
    publish(verdictToState(verdict));
    return verdict;
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    inflight = undefined;
  }
}

/** Reset the gate to `checking` (e.g. before a post-incident rotated re-check). */
export function resetPrivateBundleGate(): void {
  publish(INITIAL);
}

/**
 * The hard guard the private-room engine caller invokes BEFORE any key unlock.
 * Returns the verdict; on a lock the caller MUST NOT unlock/load room keys.  A
 * convenience wrapper around `assertPrivateBundleTrusted` that never throws.
 */
export async function requirePrivateBundleTrusted(
  deps: AssertTrustedDeps = {},
): Promise<TrustedBundleVerdict> {
  return assertPrivateBundleTrusted(deps);
}
