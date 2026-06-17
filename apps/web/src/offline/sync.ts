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
  type AttentionAggregate,
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
import { attentionUploadsCoolingDown } from '../signals/attention-cooldown.js';
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

/**
 * Dispatch one PER-OPERATION write to its typed endpoint, validating the payload
 * first. Attention aggregates are NOT sent here — they are coalesced into a
 * single batched upload by {@link drainAttentionQueue} (WS-C.4.4: attention is
 * batched, not per-event, on the replay path exactly as on the live flush).
 */
async function sendOperation(operation: PendingOperationRecord): Promise<void> {
  switch (operation.operationType) {
    case 'contribution':
      await createContribution(contributionCreateSchema.parse(operation.payload));
      return;
    case 'report':
      await createReport(createReportRequestSchema.parse(operation.payload));
      return;
    default:
      // attention-aggregate is coalesced in drainAttentionQueue; draft-sync is
      // left pending until its endpoint is wired. The caller filters both out,
      // so reaching here is a no-op guard rather than a silent drop.
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

/**
 * Apply the conflict policy to one failed operation: park terminal rejections
 * (and retry-exhausted transients) as `failed` for manual retry; otherwise
 * return it to `pending` with the attempt recorded. Shared by the per-operation
 * loop and the coalesced attention drain so both decide failures identically.
 */
async function resolveFailure(
  operation: PendingOperationRecord,
  error: unknown,
  options: SyncOptions,
  result: SyncResult,
): Promise<void> {
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

/**
 * Send all queued attention batches as ONE coalesced upload (WS-C.4.4: attention
 * is batched, not per-event — the replay path matches the live flush). Replaying
 * each queued batch as its own request would burst the per-account rate limit
 * (the very thing that fills this queue) and feed back into more 429s, so the
 * backlog is merged into a single POST. While the endpoint's Retry-After window
 * is open the batches are left pending and untouched — no network, no attempt
 * burn — to retry on a later trigger once it clears. Corrupt payloads are parked
 * as terminal; the coalesced batch shares one success/failure verdict.
 */
async function drainAttentionQueue(
  ops: PendingOperationRecord[],
  options: SyncOptions,
  result: SyncResult,
): Promise<void> {
  if (ops.length === 0 || attentionUploadsCoolingDown()) return;

  const valid: PendingOperationRecord[] = [];
  const merged: AttentionAggregate[] = [];
  for (const op of ops) {
    const parsed = attentionAggregateBatchSchema.safeParse(op.payload);
    if (parsed.success) {
      valid.push(op);
      merged.push(...parsed.data.aggregates);
    } else {
      await queue.markFailed(op.operationId, 'corrupt attention payload');
      options.onTerminalFailure?.(op, 'corrupt attention payload');
      result.failed += 1;
    }
  }
  if (valid.length === 0) return;

  for (const op of valid) await queue.markInFlight(op.operationId);
  try {
    await uploadAttentionAggregates(merged);
    for (const op of valid) await queue.remove(op.operationId);
    result.sent += valid.length;
  } catch (error) {
    for (const op of valid) await resolveFailure(op, error, options, result);
  }
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
      // Attention aggregates are coalesced into one upload below; draft-sync is
      // left pending until its endpoint is wired. Everything else (contributions,
      // reports) sends one operation at a time.
      if (
        operation.operationType === 'attention-aggregate' ||
        operation.operationType === 'draft-sync'
      ) {
        continue;
      }
      await queue.markInFlight(operation.operationId);
      try {
        await sendOperation(operation);
        await queue.remove(operation.operationId);
        result.sent += 1;
      } catch (error) {
        await resolveFailure(operation, error, options, result);
      }
    }
    await drainAttentionQueue(
      pending.filter((op) => op.operationType === 'attention-aggregate'),
      options,
      result,
    );
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
