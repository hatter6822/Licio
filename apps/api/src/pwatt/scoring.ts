// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The PWAtt window scoring job (WS-E.2.1, WS-E.2.2, WS-E.2.3). For one
// completed window: aggregate (WS-E.2.1a) → detect anti-signals (WS-E.2.2a/c)
// → compute v0 + v1 (shadow, SPEC §30.5) → apply safety-state constraints
// (WS-E.2.3e) → persist InvariantOutput rows (shadow_mode: true) → populate
// the owner-only Signal Ledger (WS-E.2.1d).
//
// Everything here is idempotent per (item, window): the fold is deterministic
// over the event store, scores are pure functions, and every persistence step
// is an upsert on a natural key — a re-run (crash recovery, lease takeover,
// triggered + scheduled overlap) converges to the same state.

import { createHash, randomUUID } from 'node:crypto';
import {
  applySafetyStateToScore,
  buildLedgerSummary,
  computePwattV0,
  computePwattV1,
  type ItemWindowInput,
  PWATT_V0_SHADOW_MODE,
  PWATT_V0_VERSION,
  PWATT_V1_VERSION,
  selectRankingProfile,
  transitionItemSafetyState,
  V1_PLACEHOLDER_PENALTY_INPUTS,
} from '@licio/invariants';
import {
  type IntegritySignalDetectedEvent,
  integritySignalDetectedEventSchema,
  type ModerationCaseCreatedEvent,
  moderationCaseCreatedEventSchema,
  TOPIC_REGISTRY,
} from '@licio/shared';
import { attentionPurgeAfterIso } from '../events/privacy-gate.js';
import type { EventPipelineServices } from '../events/services.js';
import type { AggregationWindowSize } from '../events/stores.js';
import { PRIVACY_BUCKET, type SignalLedgerRecord } from '../events/stores.js';
import type { IdentityServices } from '../identity/services.js';
import {
  computeAggregationWindow,
  toActorSummary,
  WINDOW_SIZES_MS,
  type WindowAggregationResult,
  windowLabel,
} from './aggregation.js';
import { detectCoordinatedBurst, detectHarassmentCascade } from './anti-signals.js';
import { loadPwattRuntimeConfig, type PwattRuntimeConfig } from './config.js';

/** How many trailing windows condition the base rate (WS-E.2.2a, SPEC §8). */
const BASE_RATE_TRAILING_WINDOWS = 6;

export interface WindowScoringReport {
  windowStart: string;
  windowSize: AggregationWindowSize;
  itemsScored: number;
  burstsDetected: number;
  cascadesDetected: number;
  ledgerEntriesWritten: number;
}

/**
 * A deterministic UUID (RFC 4122 shape, version nibble 8) derived from a
 * name. Anti-signal side effects key on (signal, item, window), so a window
 * RE-RUN converges instead of emitting duplicate integrity events, opening
 * duplicate safety cases, or re-freezing content moderation already cleared —
 * while a NEW window's detection still acts in full.
 */
export function deterministicEventId(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-` +
    `${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

/**
 * Store + publish a system-emitted event (integrity signal / safety case).
 * Returns false when the event id already existed (an idempotent re-run):
 * the caller must then skip its once-per-detection side effects.
 */
async function emitSystemEvent(
  events: EventPipelineServices,
  event: IntegritySignalDetectedEvent | ModerationCaseCreatedEvent,
): Promise<boolean> {
  const registryEntry = TOPIC_REGISTRY[event.event_type];
  const { inserted } = await events.eventStore.insertMany([
    {
      eventId: event.event_id,
      eventType: event.event_type,
      topic: event.event_type,
      timestamp: event.timestamp,
      privacyClassification: registryEntry.privacy_classification,
      retentionTier: registryEntry.retention_tier,
      payload: event as unknown as Record<string, unknown>,
      ownerUserId: null,
      purgeAfter: null,
    },
  ]);
  if (inserted === 0) return false;
  await events.router.publish(event);
  return true;
}

/** Freeze an item's ranking growth (WS-E.2.2c → WS-E.2.3e mechanism). */
async function freezeItem(
  events: EventPipelineServices,
  identity: IdentityServices,
  itemId: string,
  caseId: string,
  nowIso: string,
): Promise<void> {
  const current = await events.safetyStore.get(itemId);
  const state = current?.safetyState ?? 'normal';
  const transition = transitionItemSafetyState(state, 'flag');
  if (!transition.ok) return; // already frozen/removed — idempotent
  const latest = await events.invariantStore.latest('PWAtt_v0', itemId);
  await events.safetyStore.set({
    itemId,
    safetyState: transition.next,
    frozenScore: latest?.scoreVector['score'] ?? 0,
    caseId,
    updatedBy: 'system:harassment_cascade',
    updatedAt: nowIso,
  });
  // Freeze/unfreeze transitions are audit-logged (WS-E.2.3e acceptance).
  await identity.audit.append({
    actorUserId: null,
    eventType: 'safety_state_change',
    targetRef: itemId,
    context: { setting: 'safety_state', previous_value: state, new_value: transition.next },
  });
}

/**
 * Score one completed window. Returns a summary report; every side effect is
 * an idempotent upsert.
 */
export async function runPwattWindow(
  events: EventPipelineServices,
  identity: IdentityServices,
  startMs: number,
  size: AggregationWindowSize,
  preloadedConfig?: PwattRuntimeConfig,
): Promise<WindowScoringReport> {
  const config = preloadedConfig ?? (await loadPwattRuntimeConfig(events));
  const aggregation: WindowAggregationResult = await computeAggregationWindow(
    events,
    startMs,
    size,
  );
  const label = windowLabel(startMs, size);
  const nowIso = new Date(events.now()).toISOString();
  const report: WindowScoringReport = {
    windowStart: aggregation.windowStart,
    windowSize: size,
    itemsScored: 0,
    burstsDetected: 0,
    cascadesDetected: 0,
    ledgerEntriesWritten: 0,
  };

  for (const item of aggregation.items.values()) {
    // --- Anti-signal detection, conditioned on the item's own base rate ----
    const trailing = await events.windowStore.listForItemBefore(
      item.itemId,
      size,
      aggregation.windowStart,
      BASE_RATE_TRAILING_WINDOWS,
    );
    const trailingEventCounts = trailing.map((w) => w.eventCount);
    const distinctActors = item.actors.size;

    const burst = detectCoordinatedBurst(
      { eventCount: item.eventCount, distinctActors, trailingEventCounts },
      config.burst,
    );
    if (burst.detected) {
      report.burstsDetected += 1;
      const signal = integritySignalDetectedEventSchema.parse({
        event_id: deterministicEventId(`integrity:coordinated_burst:${item.itemId}:${label}`),
        event_type: 'integrity.signal.detected',
        timestamp: nowIso,
        schema_version: '1',
        signal_type: 'coordinated_burst',
        target_ids: [item.itemId],
        confidence: burst.confidence,
        evidence_summary:
          `window ${label}: volume ${item.eventCount} exceeded conditioned base rate ` +
          `${burst.expectedVolume.toFixed(1)} (x${config.burst.burstMultiplier}) with ` +
          `${distinctActors} distinct actors`,
        privacy_classification: 'restricted',
        retention_tier: 'security_log',
      });
      if (await emitSystemEvent(events, signal)) {
        // Forward to MFCI for base-rate-conditioned evaluation + review queue
        // (WS-H.3 / WS-J.2 hooks; absent hooks are recorded no-ops). Once per
        // detection: an idempotent window re-run never re-notifies.
        await events.hooks.mfci?.(signal);
        await events.hooks.reviewQueue?.(signal);
      }
    }

    const contributionCounts: Record<string, number> = {};
    for (const actor of item.actors.values()) {
      for (const [type, count] of Object.entries(actor.contributions)) {
        contributionCounts[type] = (contributionCounts[type] ?? 0) + (count ?? 0);
      }
    }
    const cascade = detectHarassmentCascade(
      {
        eventCount: item.eventCount,
        distinctActors,
        contributionCounts,
        trailingEventCounts,
      },
      config.cascade,
    );
    if (cascade.detected) {
      report.cascadesDetected += 1;
      const caseId = deterministicEventId(`case:harassment_cascade:${item.itemId}:${label}`);
      const signal = integritySignalDetectedEventSchema.parse({
        event_id: deterministicEventId(`integrity:harassment_cascade:${item.itemId}:${label}`),
        event_type: 'integrity.signal.detected',
        timestamp: nowIso,
        schema_version: '1',
        signal_type: 'harassment_cascade',
        target_ids: [item.itemId],
        confidence: cascade.confidence,
        evidence_summary:
          `window ${label}: hostile share ${(cascade.hostileShare * 100).toFixed(0)}% across ` +
          `${distinctActors} distinct actors`,
        privacy_classification: 'restricted',
        retention_tier: 'security_log',
      });
      const newDetection = await emitSystemEvent(events, signal);
      if (newDetection) {
        // High-priority safety case (WS-E.2.2c): reason code from the WS-A
        // taxonomy (MOD_HARASS_002 = sustained pile-on, severe).
        const safetyCase = moderationCaseCreatedEventSchema.parse({
          event_id: deterministicEventId(`moderation:harassment_cascade:${item.itemId}:${label}`),
          event_type: 'moderation.case.created',
          timestamp: nowIso,
          schema_version: '1',
          case_id: caseId,
          target_type: 'story',
          target_id: item.itemId,
          reporter_id: null,
          reason_code: 'MOD_HARASS_002',
          severity: 'high',
          source: 'integrity_review',
          privacy_classification: 'restricted',
          retention_tier: 'moderation_legal',
        });
        await emitSystemEvent(events, safetyCase);
        await events.hooks.safetyQueue?.(safetyCase);
        // Freeze ranking growth via the shared WS-E.2.3e mechanism — once per
        // detection, so a window re-run can never override a moderation
        // clearance of the SAME reviewed window (a NEW window's cascade still
        // freezes again). In v0 shadow the freeze has no distribution effect
        // (nothing does), but the workflow — case, state, audit — is fully
        // exercised (WS-E.2.2c).
        await freezeItem(events, identity, item.itemId, caseId, nowIso);
      }
    }

    // --- Pure scoring (v0 + v1, both SHADOW per SPEC §30.5) ---------------
    const input: ItemWindowInput = {
      itemId: item.itemId,
      actors: [...item.actors.entries()].map(([actorKey, fold]) => toActorSummary(actorKey, fold)),
      antiSignals: {
        ...(burst.detected ? { coordinatedBurst: { confidence: burst.confidence } } : {}),
        ...(cascade.detected ? { harassmentCascade: true } : {}),
      },
    };
    const v0 = computePwattV0(input, config.v0);

    const profile = selectRankingProfile(
      {
        surface: 'feed',
        freshness: 'recent',
        topicSensitivity: 'standard',
        riskState: burst.detected || cascade.detected ? 'elevated' : 'normal',
      },
      config.profiles,
    );
    const v1 = computePwattV1({
      // The freshness baseline B is supplied by the ranking layer (WS-I) at
      // decision time; stored v1 outputs carry the content-signal part only.
      baseline: 0,
      components: {
        activeAttention: v0.activeAttention,
        participation: v0.participation,
        exposureIndependence: 0, // WS-H.2 (MERI) provider integration point
        evidenceCompleteness: 0, // WS-F provider integration point
        contextCoherence: 0, // WS-H.4 (SCOI) provider integration point
      },
      profile,
      penaltyCoefficients: config.penaltyCoefficients,
      penaltyInputs: {
        coordination: burst.confidence,
        redundancy: events.hooks.redundancy?.(item.itemId) ?? 0,
        ...V1_PLACEHOLDER_PENALTY_INPUTS,
      },
    });
    // Penalty application is logged for audit + "Under Review" surfaces.
    if (v1.penalties.applied.some((p) => p.delta > 0)) {
      events.log('pwatt.penalties.applied', {
        item_id: item.itemId,
        window: label,
        penalties: v1.penalties.applied.filter((p) => p.delta > 0).map((p) => p.name),
      });
    }

    // --- Safety-state constraint (WS-E.2.3e): freeze pins, removed zeroes --
    const safety = await events.safetyStore.get(item.itemId);
    const snapshot = {
      safetyState: safety?.safetyState ?? ('normal' as const),
      frozenScore: safety?.frozenScore ?? null,
    };
    const v0Stored = applySafetyStateToScore(snapshot, v0.score);
    const v1Stored = applySafetyStateToScore(snapshot, v1.total);

    await events.invariantStore.upsert({
      invariantType: 'PWAtt_v0',
      targetType: 'story',
      targetId: item.itemId,
      timeWindow: label,
      version: PWATT_V0_VERSION,
      scoreVector: {
        active_attention: v0.activeAttention,
        participation: v0.participation,
        score: v0Stored,
        raw_score: v0.score,
      },
      explanationSummary: null,
      confidence: v0.confidence,
      shadowMode: PWATT_V0_SHADOW_MODE,
      createdAt: nowIso,
    });
    await events.invariantStore.upsert({
      invariantType: 'PWAtt',
      targetType: 'story',
      targetId: item.itemId,
      timeWindow: label,
      version: PWATT_V1_VERSION,
      scoreVector: {
        positive: v1.positive,
        total: v1Stored,
        raw_total: v1.total,
        coordination_penalty:
          v1.penalties.applied.find((p) => p.name === 'coordination')?.delta ?? 0,
        redundancy_penalty: v1.penalties.applied.find((p) => p.name === 'redundancy')?.delta ?? 0,
      },
      explanationSummary: `profile=${v1.profileName}`,
      confidence: v0.confidence,
      shadowMode: PWATT_V0_SHADOW_MODE,
      createdAt: nowIso,
    });

    // --- Signal Ledger population (WS-E.2.1d): identifiable actors only ----
    const ledgerEntries: SignalLedgerRecord[] = [];
    for (const [actorKey, fold] of item.actors) {
      if (actorKey === PRIVACY_BUCKET) continue; // pseudonymous: no ledger link
      const summaryInput = toActorSummary(actorKey, fold);
      const breakdown = v0.actorBreakdowns.find((b) => b.actor === actorKey);
      const annotations = [...(breakdown?.annotations ?? []), ...v0.annotations];
      const user = await identity.store.getUser(actorKey);
      if (!user) continue;
      const preference = user.privacySettings.attention_retention_preference;
      ledgerEntries.push({
        entryId: randomUUID(),
        ownerUserId: actorKey,
        itemId: item.itemId,
        storyTitle: events.storyTitle(item.itemId) ?? 'Untitled story',
        windowStart: aggregation.windowStart,
        windowSize: size,
        signals: {
          active_dwell_bucket: summaryInput.dwellBucket,
          source_opened: summaryInput.sourceOpened,
          source_bounce_only: summaryInput.sourceBounceOnly,
          context_opened: summaryInput.contextOpened,
          branch_depth_bucket: fold.branchDepthBucket,
          return_visit_count_bucket: summaryInput.returnVisitBucket,
          contributions: summaryInput.contributions,
          cap_reached: summaryInput.dwellBucket === 'extended',
        },
        antiSignals: annotations,
        pwattScore: v0Stored,
        summary: buildLedgerSummary({
          dwellBucket: summaryInput.dwellBucket,
          sourceOpened: summaryInput.sourceOpened,
          sourceBounceOnly: summaryInput.sourceBounceOnly,
          contextOpened: summaryInput.contextOpened,
          returnVisitBucket: summaryInput.returnVisitBucket,
          contributions: summaryInput.contributions,
          annotations,
        }),
        recordedAt: nowIso,
        purgeAfter: attentionPurgeAfterIso(preference, startMs, events.now()),
      });
    }
    if (ledgerEntries.length > 0) {
      await events.ledgerStore.upsertMany(ledgerEntries);
      report.ledgerEntriesWritten += ledgerEntries.length;
    }
    report.itemsScored += 1;
  }

  events.log('pwatt.window.scored', {
    window: label,
    items: report.itemsScored,
    bursts: report.burstsDetected,
    cascades: report.cascadesDetected,
  });
  return report;
}

/** Clear (unfreeze) or remove an item — the WS-J moderation-resolution hook
 *  (WS-E.2.3e: cleared content resumes growth; removed content scores zero). */
export async function resolveItemSafetyState(
  events: EventPipelineServices,
  identity: IdentityServices,
  itemId: string,
  action: 'clear' | 'remove',
  actor = 'system:moderation',
): Promise<{ ok: boolean; reason?: string }> {
  const current = await events.safetyStore.get(itemId);
  const state = current?.safetyState ?? 'normal';
  const transition = transitionItemSafetyState(state, action);
  if (!transition.ok) return { ok: false, reason: transition.reason };
  await events.safetyStore.set({
    itemId,
    safetyState: transition.next,
    frozenScore: transition.next === 'frozen' ? (current?.frozenScore ?? null) : null,
    caseId: current?.caseId ?? null,
    updatedBy: actor,
    updatedAt: new Date(events.now()).toISOString(),
  });
  await identity.audit.append({
    actorUserId: null,
    eventType: 'safety_state_change',
    targetRef: itemId,
    context: { setting: 'safety_state', previous_value: state, new_value: transition.next },
  });
  return { ok: true };
}

/** Compute every window size whose boundary completed at `nowMs`. */
export function dueWindows(nowMs: number): Array<{ startMs: number; size: AggregationWindowSize }> {
  const due: Array<{ startMs: number; size: AggregationWindowSize }> = [];
  for (const size of Object.keys(WINDOW_SIZES_MS) as AggregationWindowSize[]) {
    const sizeMs = WINDOW_SIZES_MS[size];
    const currentStart = Math.floor(nowMs / sizeMs) * sizeMs;
    // The previous window is complete; recompute it (idempotent upserts).
    due.push({ startMs: currentStart - sizeMs, size });
  }
  return due;
}
