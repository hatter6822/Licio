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
import {
  computeRunningBundleDigest,
  discoverPrivateBundleUrl,
  fetchPendingPrivateBundleUrl,
} from './bundle-digest.js';
import {
  loadUpdateChannelConfig,
  PRIVATE_BUNDLE_ARTIFACT_ID,
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
  /** Resolve the RUNNING private-mode chunk URL (default: DOM discovery). */
  readonly resolveBundleUrl?: () => string | undefined;
  /** Resolve the PENDING (waiting-worker) private-mode chunk URL for the SW-activation gate
   *  (default: fetch + parse the latest `index.html`). */
  readonly resolvePendingBundleUrl?: () => Promise<string | undefined>;
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
 * Resolve the target chunk's digest, fetch the signed manifest, run the pure verifier, and
 * publish the gate state.  `pending: false` verifies the RUNNING bundle (DOM-discovered,
 * `force-cache`) — the bootstrap path; `pending: true` verifies the WAITING worker's bundle
 * (latest `index.html` → chunk, `no-store`) — the SW-activation path.  Fail-closed at every step.
 *
 * Only an ACTIVATED (running) trusted build records the anti-rollback floor: recording a
 * not-yet-activated PENDING build's sequence would falsely `stale`-lock the still-current build
 * if the activation never happens (the user keeps the verified controller).
 */
async function runVerification(
  deps: AssertTrustedDeps,
  pending: boolean,
): Promise<TrustedBundleVerdict> {
  const config = deps.config ?? loadUpdateChannelConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  let verdict: TrustedBundleVerdict;
  try {
    const bundleUrl = pending
      ? await (deps.resolvePendingBundleUrl ?? (() => fetchPendingPrivateBundleUrl(fetchImpl)))()
      : (deps.resolveBundleUrl ?? (() => discoverPrivateBundleUrl()))();
    if (!bundleUrl) {
      // Cannot locate the target chunk ⇒ cannot prove its digest ⇒ lock.
      verdict = { trusted: false, reason: 'digest_mismatch' };
    } else {
      const bundleDigest = await computeRunningBundleDigest(
        bundleUrl,
        fetchImpl,
        pending ? 'no-store' : 'force-cache',
      );
      const manifest = await fetchManifest(fetchImpl);
      verdict = await verifyUpdateManifest({
        manifest,
        expectedArtifactId: PRIVATE_BUNDLE_ARTIFACT_ID,
        runningBundleDigest: bundleDigest,
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
  // Anti-rollback (§27.5): persist the trusted release sequence as the new floor (monotonic) so a
  // later validly-signed OLDER bundle is `stale` — RUNNING builds only (see the doc above).
  if (verdict.trusted && !pending) recordTrustedSequence(verdict.releaseSequence);
  // Publish RUNNING verdicts only.  A PENDING (waiting-worker) verdict must NOT
  // mutate the running gate state: `isPrivateBundleLocked()` / `useUpdateGate()` /
  // the key-unlock chokepoint reflect the bundle the user is ACTUALLY running.
  // A trusted pending build would otherwise mask a running lock, and an untrusted
  // one would lock a still-valid running surface — the SW-activation caller
  // consumes the RETURNED verdict directly (surfacing it via `onLocked`), so it
  // needs no shared publish.
  if (!pending) publish(verdictToState(verdict));
  return verdict;
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
  const run = runVerification(deps, false);
  inflight = run;
  try {
    return await run;
  } finally {
    inflight = undefined;
  }
}

/**
 * Verify the PENDING (waiting-worker) private-mode bundle for the SW-activation gate.  Hashes the
 * build the server serves NOW (the one a `SKIP_WAITING` would activate) — NOT the already-running
 * chunk — against the latest signed manifest, so a trusted current build can never wave through
 * an unverified update (and an advanced manifest no longer falsely locks a valid one).  Not
 * memoized via `inflight` (that guards the once-per-boot running check); each SW-update event
 * runs a fresh pending verification.
 */
export async function assertPendingBundleTrusted(
  deps: AssertTrustedDeps = {},
): Promise<TrustedBundleVerdict> {
  return runVerification(deps, true);
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
