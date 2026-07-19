// SPDX-License-Identifier: AGPL-3.0-or-later
//
// iOS storage-eviction detection (WS-C.2.2b, SPEC §6.9/§6.11). iOS Safari may
// evict IndexedDB/Cache without warning under storage pressure. We snapshot the
// per-store record counts to localStorage when the app is backgrounded, then on
// resume compare actual IndexedDB counts against that snapshot. A drop while the
// app was hidden — data that should still be there is gone — is classified as
// eviction (distinct from normal queue drainage, which only happens while the
// app is visible). On eviction we resync critical data and, if the pending queue
// was lost, notify the user (never silently lose a queued contribution). We also
// request persistent storage, but never assume it is granted.

import * as queue from './queue.js';
import { signalLedger } from './store.js';

const SNAPSHOT_KEY = 'licio:storage-snapshot';

// A fresh id per page load. `acknowledgedRemovalCount()` is an IN-MEMORY counter
// that resets to 0 each session, but the snapshot persists across sessions — so
// the acked-removal DELTA is only meaningful when the snapshot was written in
// THIS session. Stamping the epoch lets the probe tell same-session from a
// prior-session snapshot and pick the right baseline.
const SESSION_EPOCH: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}.${Math.trunc(Math.random() * 1e9)}`;

interface StorageSnapshot {
  pending: number;
  ledger: number;
  /** Acked-removal count at snapshot time, to discount legitimate drains. */
  removed: number;
  /** The session that wrote this snapshot (see SESSION_EPOCH). */
  epoch: string;
  at: number;
}

export type IntegrityVerdict = 'first-run' | 'ok' | 'evicted';

export interface ProbeResult {
  verdict: IntegrityVerdict;
  /** The pending queue lost data (the critical, user-notifying case). */
  lostPending: boolean;
  /** The Signal-Ledger snapshot lost data (resync from server). */
  lostLedger: boolean;
  /** Best-effort storage usage estimate in bytes, when available. */
  estimateBytes: number | null;
}

function readSnapshot(): StorageSnapshot | null {
  try {
    const raw = globalThis.localStorage?.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StorageSnapshot>;
    if (typeof parsed.pending !== 'number' || typeof parsed.ledger !== 'number') return null;
    return {
      pending: parsed.pending,
      ledger: parsed.ledger,
      removed: typeof parsed.removed === 'number' ? parsed.removed : 0,
      epoch: typeof parsed.epoch === 'string' ? parsed.epoch : '',
      at: parsed.at ?? 0,
    };
  } catch {
    return null;
  }
}

function writeSnapshot(snapshot: StorageSnapshot): void {
  try {
    globalThis.localStorage?.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage unavailable; eviction detection degrades to best-effort.
  }
}

async function currentCounts(): Promise<{ pending: number; ledger: number }> {
  const [pending, ledger] = await Promise.all([queue.count(), signalLedger.count()]);
  return { pending, ledger };
}

/** Snapshot current counts. Call when the app is backgrounded (visibility hidden). */
export async function snapshotStorage(): Promise<void> {
  const counts = await currentCounts();
  writeSnapshot({
    ...counts,
    removed: queue.acknowledgedRemovalCount(),
    epoch: SESSION_EPOCH,
    at: Date.now(),
  });
}

async function estimateBytes(): Promise<number | null> {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    return estimate?.usage ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare actual IndexedDB counts against the backgrounding snapshot. A store
 * whose actual count fell below the snapshot lost data while hidden — eviction.
 */
export async function probeStorageIntegrity(): Promise<ProbeResult> {
  const snapshot = readSnapshot();
  const [counts, estimate] = await Promise.all([currentCounts(), estimateBytes()]);
  if (!snapshot) {
    return { verdict: 'first-run', lostPending: false, lostLedger: false, estimateBytes: estimate };
  }
  // A pending-queue drop is eviction ONLY beyond what was legitimately acked-and-
  // removed since the snapshot (a background-sync flush while hidden drains the
  // queue but is not data loss). New enqueues raise the count and never trip this.
  // The acked counter resets each session, so it only shares a baseline with the
  // snapshot when the snapshot is from THIS session; across a session boundary
  // EVERY current-session ack happened after the (prior-session) snapshot, so it
  // all counts as a legitimate drain (else an early new-session drain reads as
  // eviction).
  const ackedThisSession = queue.acknowledgedRemovalCount();
  const removedDelta =
    snapshot.epoch === SESSION_EPOCH
      ? Math.max(0, ackedThisSession - snapshot.removed)
      : ackedThisSession;
  const lostPending = counts.pending < snapshot.pending - removedDelta;
  const lostLedger = counts.ledger < snapshot.ledger;
  const evicted = lostPending || lostLedger;
  // Re-baseline so a single eviction is not re-reported on the next resume.
  writeSnapshot({
    ...counts,
    removed: queue.acknowledgedRemovalCount(),
    epoch: SESSION_EPOCH,
    at: Date.now(),
  });
  return {
    verdict: evicted ? 'evicted' : 'ok',
    lostPending,
    lostLedger,
    estimateBytes: estimate,
  };
}

/**
 * Request persistent storage to reduce eviction risk (WS-C.2.2b "Harden"). Best
 * effort: returns whether it was granted, and never assumes it will be.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const persist = globalThis.navigator?.storage?.persist;
    if (!persist) return false;
    return await globalThis.navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface EvictionCallbacks {
  /** Invoked on detected eviction: resync critical data; notify if queue lost. */
  onEvicted?: (result: ProbeResult) => void;
}

/**
 * Wire eviction detection: snapshot counts on background, probe on resume
 * (visibilitychange + pageshow for bfcache). Returns teardown. Runs the probe
 * asynchronously so it never blocks initial render.
 */
export function initEvictionDetection(callbacks: EvictionCallbacks = {}): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      void snapshotStorage();
    } else {
      void runProbe();
    }
  };
  const runProbe = async (): Promise<void> => {
    const result = await probeStorageIntegrity();
    if (result.verdict === 'evicted') callbacks.onEvicted?.(result);
  };
  const onPageShow = (): void => {
    void runProbe();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
  };
}
