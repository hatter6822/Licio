// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pending-operation queue (WS-C.2.3, SPEC §6.9). The single source of truth for
// unsynced writes — contributions, reports, attention aggregates, draft sync.
// Records are validated on read/write (integrity layer) and ordered by creation
// time so they sync FIFO. The queue is NEVER cleared except on a confirmed server
// acknowledgement: an operation that exhausts retries is marked `failed` and kept
// for manual retry, never dropped ("never silently lose a queued contribution").
import {
  rawCount as rawCountStore,
  rawDelete,
  rawGet,
  rawGetAll,
  rawGetAllByIndex,
  rawPut,
  STORE,
} from './db.js';
import {
  type OperationType,
  type PendingOperationRecord,
  pendingOperationRecordSchema,
  RECORD_SCHEMA_VERSION,
} from './schemas.js';

function newOperationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Enqueue an operation as `pending`. Returns its generated operationId. */
export async function enqueue(
  operationType: OperationType,
  payload: unknown,
  operationId: string = newOperationId(),
): Promise<string> {
  const record: PendingOperationRecord = pendingOperationRecordSchema.parse({
    schemaVersion: RECORD_SCHEMA_VERSION,
    operationId,
    operationType,
    status: 'pending',
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
    payload,
  });
  await rawPut(STORE.pendingQueue, record);
  return operationId;
}

function validate(raw: unknown): PendingOperationRecord | null {
  const parsed = pendingOperationRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function byCreatedAt(a: PendingOperationRecord, b: PendingOperationRecord): number {
  return a.createdAt - b.createdAt;
}

/** All valid queued operations, oldest first. */
export async function list(): Promise<PendingOperationRecord[]> {
  const raws = await rawGetAll<unknown>(STORE.pendingQueue);
  return raws
    .map(validate)
    .filter((r): r is PendingOperationRecord => r !== null)
    .sort(byCreatedAt);
}

/** Valid operations in a given status, oldest first. */
export async function listByStatus(
  status: PendingOperationRecord['status'],
): Promise<PendingOperationRecord[]> {
  const raws = await rawGetAllByIndex<unknown>(STORE.pendingQueue, 'status', status);
  return raws
    .map(validate)
    .filter((r): r is PendingOperationRecord => r !== null)
    .sort(byCreatedAt);
}

/** Operations ready to send (pending), oldest first. */
export function listPending(): Promise<PendingOperationRecord[]> {
  return listByStatus('pending');
}

export async function get(operationId: string): Promise<PendingOperationRecord | undefined> {
  const raw = await rawGet<unknown>(STORE.pendingQueue, operationId);
  if (raw === undefined) return undefined;
  return validate(raw) ?? undefined;
}

async function update(operationId: string, patch: Partial<PendingOperationRecord>): Promise<void> {
  const current = await get(operationId);
  if (!current) return;
  await rawPut(STORE.pendingQueue, pendingOperationRecordSchema.parse({ ...current, ...patch }));
}

export function markInFlight(operationId: string): Promise<void> {
  return update(operationId, { status: 'in-flight' });
}

/** Return to `pending` for a later retry, recording the attempt + reason. */
export async function markForRetry(operationId: string, reason: string): Promise<void> {
  const current = await get(operationId);
  if (!current) return;
  await update(operationId, {
    status: 'pending',
    attempts: current.attempts + 1,
    lastError: reason,
  });
}

/** Terminal failure: keep the record (manual retry), mark failed with a reason. */
export function markFailed(operationId: string, reason: string): Promise<void> {
  return update(operationId, { status: 'failed', lastError: reason });
}

/**
 * Reclaim operations stranded `in-flight` by a process death between markInFlight
 * and the send settling (the tab was closed / the PWA was killed mid-request):
 * reset them to `pending` so the next drain re-sends them.  `attempts` is
 * preserved — an interruption is not a send failure — and re-sending is safe
 * because every replayable op carries a server idempotency key (contribution
 * `client_draft_id`, report `local_operation_id`, attention `aggregate_id`), so
 * an op the server already received is deduped.  Without this, a killed-mid-send
 * op would sit `in-flight` forever: never re-drained, never surfaced — a silent
 * loss of user-authored content that breaks the queue's core invariant.  Returns
 * the number reclaimed.
 */
export async function reclaimInFlight(): Promise<number> {
  const stranded = await listByStatus('in-flight');
  for (const operation of stranded) {
    await update(operation.operationId, { status: 'pending' });
  }
  return stranded.length;
}

// Monotonic count of operations removed after a CONFIRMED ack. Eviction
// detection reconciles a pending-count drop against this so a legitimate drain
// (incl. a background-sync flush while hidden) is not misread as data loss.
let acknowledgedRemovals = 0;

/** Remove an operation — ONLY after a confirmed server acknowledgement. */
export function remove(operationId: string): Promise<void> {
  acknowledgedRemovals += 1;
  return rawDelete(STORE.pendingQueue, operationId);
}

/** Cumulative count of acked removals (for eviction reconciliation). */
export function acknowledgedRemovalCount(): number {
  return acknowledgedRemovals;
}

export function count(): Promise<number> {
  return rawCountStore(STORE.pendingQueue);
}
