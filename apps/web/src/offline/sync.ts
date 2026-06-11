// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Background-sync processor (WS-C.2.3, SPEC §6.9). Drains the pending queue when
// connectivity returns. Conflict policy: the server is canonical for published
// content, so a server rejection (e.g. a locked thread) is TERMINAL — the
// operation is marked failed and surfaced for manual retry, never silently
// dropped, and the local draft is preserved. Transient failures (network, 5xx,
// 408/429) retry with a bounded attempt count. Drafts are client-wins and synced
// separately. iOS lacks the Background Sync API, so this runs on the foreground
// `online`/app-open path too (WS-C.2.3 edge case).
import {
  attentionAggregateBatchSchema,
  contributionCreateSchema,
  createReportRequestSchema,
} from '@licio/shared';
import { ZodError } from 'zod';
import {
  ApiClientError,
  createContribution,
  createReport,
  uploadAttentionAggregates,
} from '../lib/api.js';
import { track } from '../lib/telemetry.js';
import * as queue from './queue.js';
import type { PendingOperationRecord } from './schemas.js';

/** Max send attempts before an operation is parked as `failed` (WS-C.2.3). */
export const MAX_QUEUE_ATTEMPTS = 5;

/** Background Sync tag the service worker listens for (one queue, one tag). */
export const SYNC_TAG = 'licio-pending-queue';
/** Message the SW posts to clients to trigger a validated foreground flush. */
export const SYNC_FLUSH_MESSAGE = 'licio-sync-flush';

interface SyncRegistration extends ServiceWorkerRegistration {
  sync?: { register(tag: string): Promise<void> };
}

/**
 * Register a Background Sync so the browser fires a `sync` event when
 * connectivity returns; the SW then wakes a client to run the (validated) flush.
 * Feature-detected and best-effort — unavailable on iOS Safari, where the
 * online/app-open foreground path (initForegroundSync) is the fallback.
 */
export async function requestBackgroundSync(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (typeof window === 'undefined' || !('SyncManager' in window)) return;
  try {
    const registration = (await navigator.serviceWorker.ready) as SyncRegistration;
    await registration.sync?.register(SYNC_TAG);
  } catch {
    // Permission denied or Background Sync unsupported — non-fatal.
  }
}

export interface SyncResult {
  sent: number;
  retried: number;
  failed: number;
}

export interface SyncOptions {
  /** Called when an operation is parked as failed (notify + preserve draft). */
  onTerminalFailure?: (operation: PendingOperationRecord, reason: string) => void;
}

/** Dispatch one operation to its typed endpoint, validating the payload first. */
async function sendOperation(operation: PendingOperationRecord): Promise<void> {
  switch (operation.operationType) {
    case 'contribution':
      await createContribution(contributionCreateSchema.parse(operation.payload));
      return;
    case 'report':
      await createReport(createReportRequestSchema.parse(operation.payload));
      return;
    case 'attention-aggregate': {
      const { aggregates } = attentionAggregateBatchSchema.parse(operation.payload);
      await uploadAttentionAggregates(aggregates);
      return;
    }
    case 'draft-sync':
      // Opt-in cross-device draft sync (client-wins). Left pending until the
      // draft-sync endpoint is wired; not processed here so it never loops.
      return;
  }
}

/**
 * A failure is terminal when retrying cannot help: a 4xx server rejection
 * (conflict/validation, e.g. a locked thread), an invalid_response, or a corrupt
 * payload (ZodError). 408/429 and 5xx/network errors are transient.
 */
function isTerminal(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  if (error instanceof ApiClientError) {
    if (error.code === 'invalid_response') return true;
    if (error.status === 408 || error.status === 429) return false;
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return true;
  }
  return false;
}

let processing = false;

/**
 * Drain the pending queue once. Reentrancy-guarded so overlapping triggers
 * (online event + app open) do not double-send. Operations are removed only on a
 * confirmed server acknowledgement.
 */
export async function processPendingQueue(options: SyncOptions = {}): Promise<SyncResult> {
  const result: SyncResult = { sent: 0, retried: 0, failed: 0 };
  if (processing) return result;
  processing = true;
  try {
    const pending = await queue.listPending();
    for (const operation of pending) {
      if (operation.operationType === 'draft-sync') continue;
      await queue.markInFlight(operation.operationId);
      try {
        await sendOperation(operation);
        await queue.remove(operation.operationId);
        result.sent += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        if (isTerminal(error)) {
          await queue.markFailed(operation.operationId, reason);
          options.onTerminalFailure?.(operation, reason);
          result.failed += 1;
        } else if (operation.attempts + 1 >= MAX_QUEUE_ATTEMPTS) {
          await queue.markFailed(operation.operationId, `exhausted retries: ${reason}`);
          options.onTerminalFailure?.(operation, reason);
          result.failed += 1;
        } else {
          await queue.markForRetry(operation.operationId, reason);
          result.retried += 1;
        }
      }
    }
  } finally {
    processing = false;
  }
  // Observability: report the remaining queue depth + the terminal-failure count
  // (no payloads) so a backend outage or a class of rejected writes is visible.
  const remaining = await queue.count();
  track({
    name: 'queue_status',
    count: remaining,
    ...(result.failed > 0 ? { metric: 'failed', value: result.failed } : {}),
  });
  // Work remains (offline/transient): ask the browser to retry via Background
  // Sync when connectivity returns, even if the app is backgrounded.
  if (remaining > 0) void requestBackgroundSync();
  return result;
}

/**
 * Wire foreground sync triggers (the iOS-safe fallback for Background Sync):
 * flush on `online` and when the app returns to the foreground. Returns teardown.
 */
export function initForegroundSync(options: SyncOptions = {}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const flush = (): void => {
    void processPendingQueue(options);
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') flush();
  };
  // The SW posts this from its `sync` handler so the validated replay runs in the
  // client — no duplicated trust-boundary (zod) logic in the worker.
  const onMessage = (event: MessageEvent): void => {
    if ((event.data as { type?: string } | undefined)?.type === SYNC_FLUSH_MESSAGE) flush();
  };
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', onVisible);
  navigator.serviceWorker?.addEventListener('message', onMessage);
  // Request a sync on startup in case a queue survived the last session.
  void requestBackgroundSync();
  return () => {
    window.removeEventListener('online', flush);
    document.removeEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.removeEventListener('message', onMessage);
  };
}
