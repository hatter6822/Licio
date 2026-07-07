// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.3a/b — gateway event ingestion.  Under the v0.4 gateway contract
// Licio does NOT tail L1: it consumes the gateway's already-decoded,
// ALREADY-POST-REORG event stream by cursor.  Ingestion is idempotent over
// the (deployment, gateway_seq, gateway_index) partial-unique key (no drop,
// no duplicate on resume), events drive the §23.5 action state machine, and
// two conditions FAIL CLOSED:
//
//  - a 409 `{oldestSeq}` GAP (cursor behind the retained window): an unknown
//    range of possibly balance/freeze/governance-affecting events was lost —
//    reconciliation for the deployment HALTS, a critical divergence is
//    recorded, and the cursor only advances after `rebuildFromSnapshot`
//    re-anchors every consumer;
//
//  - an UNKNOWN event type affecting the deployment: reconciliation halts
//    into `halted_unsupported_version` (operator review; schema update)
//    rather than silently ignoring a possibly material event.
//
// A Knomosis-side revert reaches Licio AS AN EVENT in this stream; the
// affected action moves to `reverted` and its receipts update (WS-L.3.4c).

import type { AuditStore } from '../identity/audit.js';
import type { GatewayEvent, KnomosisGateway } from './gateway.js';
import { type ReceiptDeps, writeReceipts } from './receipts.js';
import type {
  KnomosisActionRecordEntity,
  KnomosisActionStore,
  OnChainEventStore,
  ReconciliationStore,
} from './stores.js';
import { applyTransition } from './submission.js';

/** The gateway event types this schema version understands (fail-closed set). */
export const KNOWN_GATEWAY_EVENT_TYPES = [
  'knomosis.action.accepted',
  'knomosis.action.settled',
  'knomosis.action.finalized',
  'knomosis.action.reverted',
  'knomosis.action.challenged',
  'knomosis.action.frozen',
] as const;
export type KnownGatewayEventType = (typeof KNOWN_GATEWAY_EVENT_TYPES)[number];

const EVENT_STATE: Readonly<
  Record<KnownGatewayEventType, KnomosisActionRecordEntity['submissionState']>
> = {
  'knomosis.action.accepted': 'accepted',
  'knomosis.action.settled': 'settled',
  'knomosis.action.finalized': 'finalized',
  'knomosis.action.reverted': 'reverted',
  'knomosis.action.challenged': 'challenged',
  'knomosis.action.frozen': 'frozen',
};

export interface IngestDeps extends ReceiptDeps {
  actions: KnomosisActionStore;
  events: OnChainEventStore;
  reconciliation: ReconciliationStore;
  audit: AuditStore;
  gateway: () => KnomosisGateway | null;
  now: () => number;
  uuid: () => string;
  log: (event: string, meta: Record<string, unknown>) => void;
  alert: (event: string, meta: Record<string, unknown>) => void;
  /** Notify the actor of a user-visible state change (push/inbox seam). */
  notifyActor: (userId: string, actionRecordId: string, state: string) => Promise<void>;
}

export type IngestOutcome =
  | { kind: 'ok'; ingested: number; latestSeq: string | null }
  | { kind: 'halted'; reason: 'gap' | 'unsupported_event'; detail: string }
  | { kind: 'unavailable' };

/** Look up the action a gateway event refers to (by typed-data hash). */
async function actionForEvent(
  deps: IngestDeps,
  deploymentId: string,
  event: GatewayEvent,
): Promise<KnomosisActionRecordEntity | null> {
  const hash = event.payload['typed_data_hash'];
  if (typeof hash !== 'string') return null;
  return deps.actions.getByTypedDataHash(deploymentId, hash);
}

/**
 * Pull + apply one batch of gateway events for a deployment (WS-L.3.3a).
 * Returns `halted` (fail closed, cursor NOT advanced) on a gap or an
 * unsupported event type.
 */
export async function ingestGatewayEvents(
  deps: IngestDeps,
  deploymentId: string,
  chainId: number,
  limit = 200,
): Promise<IngestOutcome> {
  const gateway = deps.gateway();
  if (gateway === null) return { kind: 'unavailable' };

  const cursor = await deps.events.latestGatewaySeq(deploymentId);
  const result = await gateway.getEvents(cursor, limit);
  if (result.kind === 'unavailable') return { kind: 'unavailable' };

  if (result.kind === 'gap') {
    // FAIL CLOSED: an unknown range was lost.  Persist a HALT (not a mere
    // mismatch): reconcileDeployment blocks on an unresolved `halted_event_gap`
    // exactly as it does on an unsupported version, so no tick can reconcile
    // actions against a stream already known to have dropped an unknown range.
    // The halt (and the cursor) clears only after `rebuildFromSnapshot`
    // re-anchors every consumer.
    await deps.reconciliation.append({
      resultId: deps.uuid(),
      deploymentId,
      entityType: 'action',
      entityRef: `gap:${result.oldestSeq}`,
      outcome: 'halted_event_gap',
      severity: 'critical',
      details: {
        kind: 'event_window_gap',
        cursor,
        oldest_retained_seq: result.oldestSeq,
      },
      lowWatermarkSeq: cursor,
      createdAt: new Date(deps.now()).toISOString(),
    });
    deps.alert('knomosis.ingest.gap', { deployment_id: deploymentId, oldest: result.oldestSeq });
    return { kind: 'halted', reason: 'gap', detail: `events before ${result.oldestSeq} lost` };
  }

  // A limit-full batch may end PART-WAY through a `gateway_seq` group.  Because
  // the cursor advances by seq (`getEvents` returns events with seq > cursor),
  // storing a partial trailing group would advance the derived cursor past that
  // seq and PERMANENTLY skip its remaining `gateway_index` entries.  Keep only
  // COMPLETE seq groups; the idempotent re-fetch next tick returns the whole
  // trailing group (events are keyed by `(seq, index)`, so re-ingest is a no-op).
  let batch = result.events;
  if (batch.length === limit && batch.length > 0) {
    const ordered = [...batch].sort((a, b) =>
      a.seq === b.seq ? a.index - b.index : BigInt(a.seq) < BigInt(b.seq) ? -1 : 1,
    );
    const lastSeq = ordered.at(-1)?.seq;
    const complete = ordered.filter((e) => e.seq !== lastSeq);
    if (complete.length > 0) {
      batch = complete;
    } else {
      // Pathological: a SINGLE gateway_seq holds more than `limit` events.  A
      // seq-only cursor cannot page WITHIN a seq, so storing a partial group would
      // advance the cursor and PERMANENTLY drop the rest.  FAIL CLOSED: HALT (store
      // nothing, leave the cursor untouched) and surface it, so an operator can
      // re-ingest with a larger fetch limit that covers the whole group.
      await deps.reconciliation.append({
        resultId: deps.uuid(),
        deploymentId,
        entityType: 'action',
        entityRef: `oversized:${lastSeq}`,
        outcome: 'halted_event_gap',
        severity: 'critical',
        details: { kind: 'oversized_seq_group', seq: lastSeq ?? null, limit },
        lowWatermarkSeq: await deps.events.latestGatewaySeq(deploymentId),
        createdAt: new Date(deps.now()).toISOString(),
      });
      deps.alert('knomosis.ingest.oversized_seq_group', {
        deployment_id: deploymentId,
        seq: lastSeq ?? null,
        limit,
      });
      return {
        kind: 'halted',
        reason: 'gap',
        detail: `gateway_seq ${lastSeq} exceeds the fetch limit ${limit}`,
      };
    }
  }

  // Sort into (seq, index) order so a seq group is contiguous, then find the
  // FIRST unsupported event.  We must store NOTHING from its seq group or beyond
  // — a seq-only cursor cannot page within a seq, so storing an EARLIER
  // supported index of the same seq would advance the cursor past the later
  // unsupported index and PERMANENTLY drop it after the schema is updated.  Only
  // COMPLETE supported groups strictly BELOW the halt seq are ingested (WS-L.3.3a).
  const sorted = [...batch].sort((a, b) =>
    a.seq === b.seq ? a.index - b.index : BigInt(a.seq) < BigInt(b.seq) ? -1 : 1,
  );
  const firstUnknown = sorted.find(
    (e) => !(KNOWN_GATEWAY_EVENT_TYPES as readonly string[]).includes(e.type),
  );
  const toIngest =
    firstUnknown === undefined
      ? sorted
      : sorted.filter((e) => BigInt(e.seq) < BigInt(firstUnknown.seq));

  let ingested = 0;
  for (const event of toIngest) {
    // Idempotent ingestion (per-source unique key): a replayed event is a
    // no-op, so SSE resume / cursor overlap can never double-apply.
    const { record: stored, inserted } = await deps.events.ingest({
      eventId: deps.uuid(),
      deploymentId,
      chainId,
      blockNumber: null,
      txHash: null,
      logIndex: null,
      eventType: event.type,
      decodedPayload: event.payload,
      eventSource: 'gateway',
      gatewaySeq: event.seq,
      gatewayIndex: event.index,
      // Gateway events are ALREADY post-reorg (upstream l1-ingest + kernel).
      reorgState: 'confirmed',
      reorgDetectedAt: null,
      indexedAt: new Date(deps.now()).toISOString(),
    });
    // Apply the side effects for EVERY event — new OR already-stored — because
    // storing the event and applying its transition are NOT atomic: a crash after
    // `events.ingest()` but before the transition would otherwise leave the action
    // stuck (a later settled/finalized becoming an invalid transition).  Every
    // step here is idempotent (a no-op transition returns null; receipts upsert),
    // so re-running for an existing event is safe (WS-L.3.3a).
    if (inserted) ingested += 1;

    const action = await actionForEvent(deps, deploymentId, event);
    if (action === null) continue;
    const targetState = EVENT_STATE[event.type as KnownGatewayEventType];
    const updated = await applyTransition(
      deps,
      { ...action, indexedEventRef: stored.eventId },
      targetState,
      targetState === 'reverted' ? 'reverted by the post-reorg event stream' : null,
    );
    if (updated === null) continue;

    // Stable states produce/refresh receipts and a user-visible status.
    if (
      updated.submissionState === 'settled' ||
      updated.submissionState === 'finalized' ||
      updated.submissionState === 'reverted'
    ) {
      await writeReceipts(deps, updated);
      await deps.notifyActor(updated.actorUserId, updated.actionRecordId, updated.submissionState);
    }
  }

  // After ingesting the complete supported groups below it, HALT on the first
  // unsupported event: fail closed into an unsupported-version state so an
  // operator updates the schema and clears the halt.  The cursor sits just
  // below `firstUnknown.seq`, so the whole group is re-fetched intact.
  if (firstUnknown !== undefined) {
    await deps.reconciliation.append({
      resultId: deps.uuid(),
      deploymentId,
      entityType: 'action',
      entityRef: `event:${firstUnknown.seq}.${firstUnknown.index}`,
      outcome: 'halted_unsupported_version',
      severity: 'critical',
      details: {
        kind: 'unknown_event_type',
        event_type: firstUnknown.type,
        seq: firstUnknown.seq,
      },
      lowWatermarkSeq: firstUnknown.seq,
      createdAt: new Date(deps.now()).toISOString(),
    });
    deps.alert('knomosis.ingest.unsupported_event', {
      deployment_id: deploymentId,
      event_type: firstUnknown.type,
    });
    return {
      kind: 'halted',
      reason: 'unsupported_event',
      detail: `unknown event type "${firstUnknown.type}" at seq ${firstUnknown.seq}`,
    };
  }
  return { kind: 'ok', ingested, latestSeq: result.latestSeq };
}

/**
 * FAIL-CLOSED rebuild after a gap: re-anchor EVERY gateway-event consumer —
 * financial standing (marking all non-terminal actions for re-reconciliation)
 * AND action/governance state — before the cursor may advance again.  The
 * standing snapshots are re-read at the current X-Knomosis-Seq by the
 * reconciliation engine once actions are marked `pending`.
 */
export async function rebuildFromSnapshot(
  deps: IngestDeps,
  deploymentId: string,
): Promise<{ remarked: number }> {
  const nowIso = new Date(deps.now()).toISOString();
  const open = await deps.actions.listUnreconciled(deploymentId, 10_000);
  let remarked = 0;
  for (const record of open) {
    await deps.actions.update({
      ...record,
      reconciliationState: 'pending',
      updatedAt: nowIso,
    });
    remarked += 1;
  }
  // Clear the gap halt(s) this rebuild re-anchors: append a resolving `match`
  // for each unresolved `halted_event_gap` so reconcileDeployment resumes (the
  // gap is the recovery path's explicit close; unsupported-version halts clear
  // via the separate schema-update path, not here).
  const unresolved = await deps.reconciliation.listUnresolvedMismatches(deploymentId);
  let clearedGaps = 0;
  for (const result of unresolved) {
    if (result.outcome !== 'halted_event_gap') continue;
    await deps.reconciliation.append({
      resultId: deps.uuid(),
      deploymentId,
      entityType: result.entityType,
      entityRef: result.entityRef,
      outcome: 'match',
      severity: null,
      details: { kind: 'event_window_gap_rebuilt', remarked },
      lowWatermarkSeq: result.lowWatermarkSeq,
      createdAt: nowIso,
    });
    // RE-ANCHOR the resume cursor to the retained-window start.  The dropped
    // events were never stored, so the derived max-stored seq is still PRE-gap;
    // without this the next tick re-fetches the same gap and re-halts forever.
    // getEvents returns seq > cursor, so anchor at `oldestRetained - 1` to include
    // the whole retained window on the next pull.
    const oldestRetained = result.details['oldest_retained_seq'];
    if (typeof oldestRetained === 'string' && /^\d+$/.test(oldestRetained)) {
      await deps.events.recordGatewayCursor(deploymentId, (BigInt(oldestRetained) - 1n).toString());
    }
    clearedGaps += 1;
  }
  await deps.audit.append({
    actorUserId: null,
    eventType: 'knomosis_config_change',
    targetRef: deploymentId,
    context: { setting: 'rebuild_from_snapshot', new_value: String(remarked) },
  });
  deps.log('knomosis.ingest.rebuilt', { deployment_id: deploymentId, remarked, clearedGaps });
  return { remarked };
}
