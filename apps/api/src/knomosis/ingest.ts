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
    // FAIL CLOSED: an unknown range was lost.  Record a critical divergence
    // and halt — the cursor never advances past a gap until the rebuild
    // (rebuildFromSnapshot) has re-anchored every consumer.
    await deps.reconciliation.append({
      resultId: deps.uuid(),
      deploymentId,
      entityType: 'action',
      entityRef: `gap:${result.oldestSeq}`,
      outcome: 'mismatch',
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

  let ingested = 0;
  for (const event of result.events) {
    const known = (KNOWN_GATEWAY_EVENT_TYPES as readonly string[]).includes(event.type);
    if (!known) {
      // FAIL CLOSED on an unknown event affecting a tracked deployment: halt
      // this deployment's reconciliation into an unsupported-version state.
      await deps.reconciliation.append({
        resultId: deps.uuid(),
        deploymentId,
        entityType: 'action',
        entityRef: `event:${event.seq}.${event.index}`,
        outcome: 'halted_unsupported_version',
        severity: 'critical',
        details: { kind: 'unknown_event_type', event_type: event.type, seq: event.seq },
        lowWatermarkSeq: event.seq,
        createdAt: new Date(deps.now()).toISOString(),
      });
      deps.alert('knomosis.ingest.unsupported_event', {
        deployment_id: deploymentId,
        event_type: event.type,
      });
      return {
        kind: 'halted',
        reason: 'unsupported_event',
        detail: `unknown event type "${event.type}" at seq ${event.seq}`,
      };
    }

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
    if (!inserted) continue;
    ingested += 1;

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
  const open = await deps.actions.listUnreconciled(deploymentId, 10_000);
  let remarked = 0;
  for (const record of open) {
    await deps.actions.update({
      ...record,
      reconciliationState: 'pending',
      updatedAt: new Date(deps.now()).toISOString(),
    });
    remarked += 1;
  }
  await deps.audit.append({
    actorUserId: null,
    eventType: 'knomosis_config_change',
    targetRef: deploymentId,
    context: { setting: 'rebuild_from_snapshot', new_value: String(remarked) },
  });
  deps.log('knomosis.ingest.rebuilt', { deployment_id: deploymentId, remarked });
  return { remarked };
}
