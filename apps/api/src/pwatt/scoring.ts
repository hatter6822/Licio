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
  applySafetyStateToComponents,
  applySafetyStateToScore,
  buildLedgerSummary,
  computePwattV0,
  computePwattV1Components,
  type ItemWindowInput,
  PWATT_V0_SHADOW_MODE,
  PWATT_V0_VERSION,
  PWATT_V1_VERSION,
  pwattV0ScoreVectorSchema,
  pwattV1ScoreVectorSchema,
  transitionItemSafetyState,
} from '@licio/invariants';
import {
  integritySignalDetectedEventSchema,
  invariantRunCompletedEventSchema,
  type LicioEvent,
  moderationCaseCreatedEventSchema,
  TOPIC_REGISTRY,
  threadStateChangedEventSchema,
} from '@licio/shared';
import { attentionPurgeAfterIso } from '../events/privacy-gate.js';
import type { EventPipelineServices } from '../events/services.js';
import type { AggregationWindowSize } from '../events/stores.js';
import { PRIVACY_BUCKET, type SignalLedgerRecord } from '../events/stores.js';
import type { IdentityServices } from '../identity/services.js';
import {
  computeAggregationWindow,
  SCORING_TOPICS,
  toActorSummary,
  WINDOW_SIZES_MS,
  type WindowAggregationResult,
  windowBounds,
  windowLabel,
} from './aggregation.js';
import {
  accountTrustWeight,
  detectCoordinatedBurst,
  detectHarassmentCascade,
} from './anti-signals.js';
import { loadPwattRuntimeConfig, type PwattRuntimeConfig } from './config.js';
import { pwattRowForRanking } from './shadow.js';

/** How many trailing windows condition the base rate (WS-E.2.2a, SPEC §8). */
const BASE_RATE_TRAILING_WINDOWS = 6;

/** The salting-resistant low quantile of an item's actor trust weights (the
 *  25th percentile; absent ⇒ 1, no effect). Sorting ascending and reading near
 *  the bottom means a minority of high-trust (aged) accounts can't lift the
 *  factor, so a fresh-account brigade stays flagged unless it is MAJORITY aged. */
function lowQuantileTrust(weights: readonly number[]): number {
  if (weights.length === 0) return 1;
  const sorted = [...weights].sort((a, b) => a - b);
  const index = Math.floor(0.25 * (sorted.length - 1));
  return sorted[index] ?? 1;
}

export interface WindowScoringReport {
  windowStart: string;
  windowSize: AggregationWindowSize;
  itemsScored: number;
  burstsDetected: number;
  cascadesDetected: number;
  ledgerEntriesWritten: number;
}

/**
 * The fixed WS-E name-based UUID namespace (itself a v4 constant). Generated
 * once for this codebase; deterministic ids are stable as long as it is.
 */
const WS_E_UUID_NAMESPACE = '6f1c1ce4-8c6f-4a3e-9b51-2d3f4a5b6c7d';

/**
 * A name-based RFC 9562 version-8 UUID over SHA-256(namespace ‖ name) — the
 * same construction as a v5 UUID with the deprecated SHA-1 replaced by
 * SHA-256 (v8 is the RFC's vehicle for exactly this). Anti-signal and
 * system-event side effects key on (kind, item, window), so a window RE-RUN
 * converges instead of emitting duplicate integrity events, opening duplicate
 * safety cases, or re-freezing content moderation already cleared — while a
 * NEW window's detection still acts in full.
 */
export function deterministicEventId(name: string): string {
  const namespaceBytes = Buffer.from(WS_E_UUID_NAMESPACE.replaceAll('-', ''), 'hex');
  const digest = createHash('sha256')
    .update(namespaceBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // RFC 9562 §4: set the version (8) and variant (10xx) bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Store + publish a system-emitted event (integrity signal / safety case).
 * Returns false when the event id already existed (an idempotent re-run):
 * the caller must then skip its once-per-detection side effects.
 */
async function emitSystemEvent(events: EventPipelineServices, event: LicioEvent): Promise<boolean> {
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
      createdAt: new Date(events.now()).toISOString(),
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
  const latestV0 = await events.invariantStore.latest('PWAtt_v0', itemId);
  const latestScore = latestV0?.scoreVector['score'];
  // Pin the SERVED components at their PRE-cascade level (§5.3 freeze growth):
  // freeze runs BEFORE this window's row is stored, so `latest` is the last
  // pre-cascade good state (v1 preferred — the served source — then v0). Read it
  // through the SAME §30.5 serving-row gate ranking uses, so a shadow / degraded
  // / pre-lift row is NEVER laundered into a served frozen component (it counts
  // as ABSENT). No serving row (or a brand-new first-window cascade) ⇒ null ⇒
  // pinned to 0 by applySafetyStateToComponents.
  const componentRow =
    pwattRowForRanking(await events.invariantStore.latest('PWAtt_v1', itemId)) ??
    pwattRowForRanking(latestV0);
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  await events.safetyStore.set({
    itemId,
    safetyState: transition.next,
    frozenScore: typeof latestScore === 'number' ? latestScore : 0,
    frozenActiveAttention: numberOrNull(componentRow?.scoreVector['active_attention']),
    frozenParticipation: numberOrNull(componentRow?.scoreVector['participation']),
    caseId,
    updatedBy: 'system:harassment_cascade',
    updatedAt: nowIso,
  });
  // Freeze/unfreeze transitions are audit-logged (WS-E.2.3e acceptance) AND
  // emitted as the §21.3 `thread.state.changed` safety-dimension event
  // (WS-E.1.1e acceptance: "defined and emitted on safety transitions").
  await identity.audit.append({
    actorUserId: null,
    eventType: 'safety_state_change',
    targetRef: itemId,
    context: { setting: 'safety_state', previous_value: state, new_value: transition.next },
  });
  await emitThreadSafetyStateChanged(events, itemId, state, transition.next, nowIso);
}

/**
 * Emit the safety-dimension `thread.state.changed` event for an item. The
 * item is the story; the v0 demo content model maps threads 1:1 onto stories
 * (the distinct thread id arrives with WS-G), so both ids carry the item id.
 */
async function emitThreadSafetyStateChanged(
  events: EventPipelineServices,
  itemId: string,
  oldState: string,
  newState: string,
  nowIso: string,
): Promise<void> {
  await emitSystemEvent(
    events,
    threadStateChangedEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'thread.state.changed',
      timestamp: nowIso,
      schema_version: '1',
      thread_id: itemId,
      story_id: itemId,
      state_dimension: 'safety',
      old_state: oldState,
      new_state: newState,
      changed_by: 'system',
      privacy_classification: 'sensitive',
      retention_tier: 'ranking_log',
    }),
  );
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
  // A stable identity of the scoring-relevant runtime config, stamped on every
  // stored PWAtt row so the ranking feature store's `config_hash` (derived from
  // versionMetadata) VARIES with the applied weights/attenuation/trust — replay
  // and audit can then tell which config produced a stored component (WS-I.2.1c).
  const configHash = createHash('sha256')
    .update(
      JSON.stringify({
        v0: config.v0,
        v1: config.v1,
        trustWeights: config.trustWeights,
        // The anti-signal DETECTOR configs are part of the scoring identity too:
        // they decide whether a burst/cascade fires, which changes v0 dampening,
        // the v1 anti_signal_factor, the served components, and the freeze — so
        // tuning either must change the replay/audit hash (WS-I.2.1c).
        burst: config.burst,
        cascade: config.cascade,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  const aggregation: WindowAggregationResult = await computeAggregationWindow(
    events,
    startMs,
    size,
  );
  const label = windowLabel(startMs, size);
  const bounds = windowBounds(startMs, size);
  const nowIso = new Date(events.now()).toISOString();
  const report: WindowScoringReport = {
    windowStart: aggregation.windowStart,
    windowSize: size,
    itemsScored: 0,
    burstsDetected: 0,
    cascadesDetected: 0,
    ledgerEntriesWritten: 0,
  };

  // WS-O.4.5 — account-age trust factor of an actor (memoized across the window),
  // used for BOTH the burst-detection threshold AND the per-actor score scaling.
  // Anonymous (privacy-bucket) and unresolvable actors are treated as FULLY
  // TRUSTED (literal 1) — NOT the configurable `established` weight, which a
  // steward may set below 1: anonymity must never be penalized, and a privacy
  // reader's served PWAtt components must never depend on trust config. Only
  // RESOLVABLE fresh accounts lower the factor. Account age is the coarse,
  // non-financial signal MFCI already uses; no age ever leaves this function.
  const nowMs = events.now();
  const trustCache = new Map<string, number>();
  const actorTrust = async (actorKey: string): Promise<number> => {
    if (actorKey === PRIVACY_BUCKET) return 1;
    const cached = trustCache.get(actorKey);
    if (cached !== undefined) return cached;
    const user = await identity.store.getUser(actorKey);
    const weight = user
      ? accountTrustWeight((nowMs - Date.parse(user.createdAt)) / 86_400_000, config.trustWeights)
      : 1;
    trustCache.set(actorKey, weight);
    return weight;
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
    // A burst dominated by fresh, disposable accounts is flagged at lower volume
    // (WS-O.4.5): a LOW QUANTILE of the actors' trust weights scales the
    // detection threshold down. The quantile (not the mean) resists SALTING — a
    // minority of aged accounts mixed into a fresh brigade can't lift the factor
    // (you need a MAJORITY of aged, expensive accounts to evade) — while a
    // legitimate aged community with a few new users keeps a high factor. A
    // genuinely viral item drawing a MAJORITY of new users may also trip the
    // lowered threshold; that is an accepted trade-off (flags are shadow and the
    // exact fiber test + human review clear organic virality).
    // Resolve each actor's account-age trust ONCE (WS-O.4.5): the low quantile
    // scales the burst DETECTION threshold, and the SAME per-actor factor
    // scales that actor's SCORE contribution (so a fresh-account brigade both
    // trips detection sooner AND earns less distribution power).
    const trustByActor = new Map<string, number>();
    for (const actorKey of item.actors.keys()) {
      trustByActor.set(actorKey, await actorTrust(actorKey));
    }
    const trustFactor = lowQuantileTrust([...trustByActor.values()]);

    const burst = detectCoordinatedBurst(
      { eventCount: item.eventCount, distinctActors, trailingEventCounts, trustFactor },
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
        trustFactor,
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
    const computeStartedAt = Date.now();
    const input: ItemWindowInput = {
      itemId: item.itemId,
      actors: [...item.actors.entries()].map(([actorKey, fold]) =>
        toActorSummary(actorKey, fold, trustByActor.get(actorKey) ?? 1),
      ),
      antiSignals: {
        ...(burst.detected ? { coordinatedBurst: { confidence: burst.confidence } } : {}),
        ...(cascade.detected ? { harassmentCascade: true } : {}),
      },
    };
    const v0 = computePwattV0(input, config.v0);

    // The INTEGRATED v1 stage (WS-E.2.3a/b) produces the two CONTENT components
    // — ActiveAttention and ConstructiveParticipation — with the contribution-
    // type hierarchy, per-user/per-dimension saturation, account-age trust, and
    // the window's own anti-signal attenuation. It deliberately stops there: the
    // full §5.4 composite (baseline B, MERI/evidence/SCOI terms, promotion-gated
    // penalties) is a per-REQUEST quantity the batch engine cannot know (B
    // carries the requesting user's freshness/relevance), so it is composed at
    // decision time by the SINGLE production §5.4 implementation, @licio/ranking
    // (`computePositiveScore` + `computePenalties`). The engine persists only
    // what it can legitimately compute; no second, partial §5.4 is stored.
    const v1Components = computePwattV1Components(input.actors, config.v1, input.antiSignals);
    if (v1Components.antiSignalAnnotations.length > 0) {
      events.log('pwatt.anti_signal.attenuated', {
        item_id: item.itemId,
        window: label,
        factor: v1Components.antiSignalFactor,
        signals: v1Components.antiSignalAnnotations,
      });
    }
    const computationTimeMs = Math.max(0, Date.now() - computeStartedAt);

    // --- Safety-state constraint (WS-E.2.3e): freeze pins, removed zeroes --
    // The pin binds the COMPONENTS the ranking feature store reads, not only
    // the composite score/total (§5.3 "freeze ranking growth"): a frozen item
    // keeps its pre-cascade component level, a removed item zeroes, so the
    // freeze actually stops attention-driven growth on the served path.
    const safety = await events.safetyStore.get(item.itemId);
    const snapshot = {
      safetyState: safety?.safetyState ?? ('normal' as const),
      frozenScore: safety?.frozenScore ?? null,
      frozenActiveAttention: safety?.frozenActiveAttention ?? null,
      frozenParticipation: safety?.frozenParticipation ?? null,
    };
    const v0Stored = applySafetyStateToScore(snapshot, v0.score);
    const v0Served = applySafetyStateToComponents(snapshot, {
      activeAttention: v0.activeAttention,
      participation: v0.participation,
    });
    const v1Served = applySafetyStateToComponents(snapshot, {
      activeAttention: v1Components.activeAttention,
      participation: v1Components.participation,
    });

    await events.invariantStore.upsert({
      invariantType: 'PWAtt_v0',
      targetType: 'story',
      targetId: item.itemId,
      timeWindow: bounds,
      version: PWATT_V0_VERSION,
      // Strict-validated at the write site (WS-H.1.1d): a shape drift fails
      // loudly here instead of silently zeroing PWAtt's ranking influence.
      scoreVector: pwattV0ScoreVectorSchema.parse({
        active_attention: v0Served.activeAttention,
        participation: v0Served.participation,
        raw_active_attention: v0.activeAttention,
        raw_participation: v0.participation,
        score: v0Stored,
        raw_score: v0.score,
      }),
      explanationSummary: null,
      confidence: v0.confidence,
      // The window fold consumes its own complete inputs (WS-H.1.1c).
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: { config_hash: configHash },
      shadowMode: PWATT_V0_SHADOW_MODE,
      createdAt: nowIso,
    });
    await events.invariantStore.upsert({
      invariantType: 'PWAtt_v1',
      targetType: 'story',
      targetId: item.itemId,
      timeWindow: bounds,
      version: PWATT_V1_VERSION,
      // Strict-validated at the write site (WS-H.1.1d): the SERVED content
      // components (safety-pinned) the ranking feature store consumes; the RAW
      // pair + the anti-signal factor are audit-only.
      scoreVector: pwattV1ScoreVectorSchema.parse({
        active_attention: v1Served.activeAttention,
        participation: v1Served.participation,
        raw_active_attention: v1Components.rawActiveAttention,
        raw_participation: v1Components.rawParticipation,
        anti_signal_factor: v1Components.antiSignalFactor,
      }),
      explanationSummary: null,
      confidence: v0.confidence,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: { config_hash: configHash },
      shadowMode: PWATT_V0_SHADOW_MODE,
      createdAt: nowIso,
    });

    // WS-E.1.1e: `invariant.run.completed` marks the FIRST completion of this
    // item/window computation (deterministic id ⇒ idempotent re-runs do not
    // duplicate it; the InvariantOutput rows above remain the current truth).
    await emitSystemEvent(
      events,
      invariantRunCompletedEventSchema.parse({
        event_id: deterministicEventId(`invariant:PWAtt:${item.itemId}:${label}`),
        event_type: 'invariant.run.completed',
        timestamp: nowIso,
        schema_version: '1',
        invariant_type: 'PWAtt',
        target_type: 'story',
        target_id: item.itemId,
        time_window: label,
        version: PWATT_V0_VERSION,
        score_vector: {
          v0_score: v0Stored,
          v0_raw: v0.score,
          v1_active_attention: v1Served.activeAttention,
          v1_participation: v1Served.participation,
        },
        confidence: v0.confidence,
        computation_time_ms: computationTimeMs,
        privacy_classification: 'sensitive',
        retention_tier: 'ranking_log',
      }),
    );

    // --- Signal Ledger population (WS-E.2.1d): identifiable actors only ----
    // ONE canonical entry per (user, item, hour): only the 1h window writes
    // ledger rows — the 6h/24h/7d windows would otherwise produce
    // near-duplicate entries for the same activity. (Scores for the larger
    // windows remain in invariant_outputs, which is their audience.)
    const ledgerEntries: SignalLedgerRecord[] = [];
    if (size !== '1h') {
      report.itemsScored += 1;
      continue;
    }
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
          reply_depth_bucket: fold.branchDepthBucket,
          return_visit_count_bucket: summaryInput.returnVisitBucket,
          // §5.3 "Save for later": the deduped, scored save boolean, so a
          // save-only window renders a checklist item instead of "nothing
          // counted" — mirrors the scored `savedForLater` component.
          saved_for_later: summaryInput.savedForLater === 1,
          contributions: summaryInput.contributions,
          // Cap status is knowable only on the client (the §22.1 wire carries
          // buckets, whose ceilings ARE the cap expression) — the ledger entry
          // honestly omits it rather than guessing.
        },
        antiSignals: annotations,
        pwattScore: v0Stored,
        summary: buildLedgerSummary({
          dwellBucket: summaryInput.dwellBucket,
          sourceOpened: summaryInput.sourceOpened,
          sourceBounceOnly: summaryInput.sourceBounceOnly,
          contextOpened: summaryInput.contextOpened,
          savedForLater: summaryInput.savedForLater === 1,
          replyDepthBucket: fold.branchDepthBucket,
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
  const stayFrozen = transition.next === 'frozen';
  await events.safetyStore.set({
    itemId,
    safetyState: transition.next,
    frozenScore: stayFrozen ? (current?.frozenScore ?? null) : null,
    frozenActiveAttention: stayFrozen ? (current?.frozenActiveAttention ?? null) : null,
    frozenParticipation: stayFrozen ? (current?.frozenParticipation ?? null) : null,
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
  await emitThreadSafetyStateChanged(
    events,
    itemId,
    state,
    transition.next,
    new Date(events.now()).toISOString(),
  );
  return { ok: true };
}

/**
 * How many completed trailing windows per size the scheduler checks for
 * freshness each tick. Coverage: ~26h of hourly windows, ~36h of 6-hour
 * windows, ~8 days of daily windows, and ~14 days of weekly windows — so an
 * offline-sync event up to the 7-day acceptance ceiling re-opens at least its
 * daily and weekly windows (deeper lates fold into the larger sizes only;
 * documented in docs/events/README.md).
 */
export const TRAILING_RECOMPUTE_WINDOWS: Readonly<Record<AggregationWindowSize, number>> = {
  '1h': 26,
  '6h': 6,
  '24h': 8,
  '7d': 2,
};

/**
 * The completed windows that actually NEED (re)computation at `nowMs`: a
 * window is due when any event in its range was RECEIVED (created_at) after
 * the window's last computedAt — so a freshly completed window computes once,
 * a late-arriving offline event re-opens its windows, and an unchanged window
 * is skipped (no more hourly full recomputes of the 7-day window). Deletions
 * do not retro-shrink already-computed anonymous aggregates by design.
 */
export async function windowsNeedingCompute(
  events: EventPipelineServices,
  nowMs: number,
): Promise<Array<{ startMs: number; size: AggregationWindowSize }>> {
  const due: Array<{ startMs: number; size: AggregationWindowSize }> = [];
  for (const size of Object.keys(WINDOW_SIZES_MS) as AggregationWindowSize[]) {
    const sizeMs = WINDOW_SIZES_MS[size];
    const currentStart = Math.floor(nowMs / sizeMs) * sizeMs;
    for (let back = 1; back <= TRAILING_RECOMPUTE_WINDOWS[size]; back += 1) {
      const startMs = currentStart - back * sizeMs;
      const fromIso = new Date(startMs).toISOString();
      const toIso = new Date(startMs + sizeMs).toISOString();
      const latestArrival = await events.eventStore.latestCreatedAtBetween(
        SCORING_TOPICS,
        fromIso,
        toIso,
      );
      if (latestArrival === null) continue; // empty window: nothing to compute
      const computedAt = await events.windowStore.latestComputedAt(fromIso, size);
      // >= (not >): an arrival in the SAME millisecond as the last compute
      // must still trigger one more (idempotent) recompute — the next
      // computedAt is strictly later, so the loop settles immediately.
      if (computedAt === null || Date.parse(latestArrival) >= Date.parse(computedAt)) {
        due.push({ startMs, size });
      }
    }
  }
  return due;
}
