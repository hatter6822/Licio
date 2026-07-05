// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Event aggregation per item/window (WS-E.2.1a, SPEC §5.4). A deterministic
// fold over the durable event store for [windowStart, windowStart + size):
// same store contents ⇒ same outputs, so re-running is idempotent (the window
// row is an upsert) and scoring is reproducible (SPEC §30.6).
//
// Per-user deduplication is structural: signals fold into ONE ActorItemSummary
// per (actor, item) — buckets join by maximum, booleans by OR — so a user's
// repeated attention in a window never inflates counts (the first structural
// defense against refresh loops, SPEC §30.5). Pseudonymous (minimum-privacy)
// events share the single privacy-bucket actor: they can only ever
// UNDER-count, never inflate.

import type { ActorItemSummary } from '@licio/invariants';
import {
  type AttentionAggregateEvent,
  type ContentSavedAggregateEvent,
  DWELL_BUCKETS,
  type DwellBucket,
  type EventContributionType,
  type IntegritySignalDetectedEvent,
  REPLY_DEPTH_BUCKETS,
  RETURN_VISIT_BUCKETS,
  type ReplyDepthBucket,
  type ReturnVisitBucket,
  type SourceOpenedAggregateEvent,
} from '@licio/shared';
import { actorKeyOfPayload, type EventPipelineServices } from '../events/services.js';
import type { AggregationWindowRecord, AggregationWindowSize } from '../events/stores.js';

export const WINDOW_SIZES_MS: Readonly<Record<AggregationWindowSize, number>> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
};

/** Floor an instant to the start of its window of the given size. */
export function windowStartMs(epochMs: number, size: AggregationWindowSize): number {
  const sizeMs = WINDOW_SIZES_MS[size];
  return Math.floor(epochMs / sizeMs) * sizeMs;
}

/** The §21.4-style window label: `<start ISO>/<size>`. */
export function windowLabel(startMs: number, size: AggregationWindowSize): string {
  return `${new Date(startMs).toISOString()}/${size}`;
}

/** The half-open [start, end) window bounds (WS-H.1.1a `time_window`). */
export function windowBounds(
  startMs: number,
  size: AggregationWindowSize,
): { start: string; end: string } {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + WINDOW_SIZES_MS[size]).toISOString(),
  };
}

function maxBucket<T extends string>(order: readonly T[], a: T, b: T): T {
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** Mutable per-(actor, item) fold state. */
interface ActorFold {
  dwellBucket: DwellBucket;
  branchDepthBucket: ReplyDepthBucket;
  returnVisitBucket: ReturnVisitBucket;
  sawMeaningfulSourceOpen: boolean;
  /** Bounce-adjacent evidence only: bounce=true, or a `brief` source dwell. */
  sawBounceAdjacentOpen: boolean;
  contextOpened: boolean;
  /** The actor saved this item for later (§5.3 SIG-ATT-SAVE; deduped by OR). */
  saved: boolean;
  contributions: Partial<Record<EventContributionType, number>>;
  uncitedAccusationsByType: Partial<Record<EventContributionType, number>>;
  /** WS-T — contributions WITH an attached source, by type (the positive
   *  citation weight; the structural inverse of the uncited downweight). */
  citedContributionsByType: Partial<Record<EventContributionType, number>>;
}

export interface ItemAggregation {
  itemId: string;
  actors: Map<string, ActorFold>;
  antiSignalCounts: Record<string, number>;
  eventCount: number;
}

export interface WindowAggregationResult {
  windowStart: string;
  windowSize: AggregationWindowSize;
  items: Map<string, ItemAggregation>;
}

export const SCORING_TOPICS = [
  'attention.aggregate',
  'source.opened.aggregate',
  'content.saved',
  'contribution.created',
  'evidence.added',
  'integrity.signal.detected',
] as const;

function emptyActor(): ActorFold {
  return {
    dwellBucket: 'none',
    branchDepthBucket: 'none',
    returnVisitBucket: 'none',
    sawMeaningfulSourceOpen: false,
    sawBounceAdjacentOpen: false,
    contextOpened: false,
    saved: false,
    contributions: {},
    uncitedAccusationsByType: {},
    citedContributionsByType: {},
  };
}

/**
 * Fold the window's events into per-item, per-actor summaries and upsert the
 * `AggregationWindow` rows. Returns the fold for the scoring stage.
 */
export async function computeAggregationWindow(
  events: EventPipelineServices,
  startMs: number,
  size: AggregationWindowSize,
): Promise<WindowAggregationResult> {
  const fromIso = new Date(startMs).toISOString();
  const toIso = new Date(startMs + WINDOW_SIZES_MS[size]).toISOString();
  const rows = await events.eventStore.listByTopicsBetween(SCORING_TOPICS, fromIso, toIso);

  const items = new Map<string, ItemAggregation>();
  const itemOf = (itemId: string): ItemAggregation => {
    let item = items.get(itemId);
    if (!item) {
      item = { itemId, actors: new Map(), antiSignalCounts: {}, eventCount: 0 };
      items.set(itemId, item);
    }
    return item;
  };
  const actorOf = (item: ItemAggregation, actorKey: string): ActorFold => {
    let actor = item.actors.get(actorKey);
    if (!actor) {
      actor = emptyActor();
      item.actors.set(actorKey, actor);
    }
    return actor;
  };

  for (const row of rows) {
    if (row.topic === 'attention.aggregate') {
      const event = row.payload as unknown as AttentionAggregateEvent;
      const actorKey = actorKeyOfPayload(row.payload);
      for (const entry of event.items) {
        const item = itemOf(entry.story_id);
        item.eventCount += 1;
        const actor = actorOf(item, actorKey);
        actor.dwellBucket = maxBucket(DWELL_BUCKETS, actor.dwellBucket, entry.active_dwell_bucket);
        actor.branchDepthBucket = maxBucket(
          REPLY_DEPTH_BUCKETS,
          actor.branchDepthBucket,
          entry.reply_depth_bucket,
        );
        actor.returnVisitBucket = maxBucket(
          RETURN_VISIT_BUCKETS,
          actor.returnVisitBucket,
          entry.return_visit_count_bucket,
        );
        // The client tracker reports source_opened only after a meaningful
        // (persistence-thresholded) open — a non-bounce signal.
        if (entry.source_opened) actor.sawMeaningfulSourceOpen = true;
        if (entry.context_opened) actor.contextOpened = true;
      }
    } else if (row.topic === 'source.opened.aggregate') {
      const event = row.payload as unknown as SourceOpenedAggregateEvent;
      const item = itemOf(event.story_id);
      item.eventCount += 1;
      const actor = actorOf(item, actorKeyOfPayload(row.payload));
      // The §5.3 clickbait guardrail (WS-E.1.1b): a bounce, AND the
      // bounce-adjacent `brief` dwell bucket, earn zero source weight — only
      // a moderate/extended non-bounce visit is a meaningful open.
      if (event.bounce || event.dwell_bucket === 'brief') actor.sawBounceAdjacentOpen = true;
      else actor.sawMeaningfulSourceOpen = true;
    } else if (row.topic === 'content.saved') {
      // §5.3 "Save for later": a discrete, deduped low-weight interest signal.
      // Booleans join by OR, so one user's repeated save counts once (the
      // structural refresh-loop defense, WS-E.2.1a).
      const event = row.payload as unknown as ContentSavedAggregateEvent;
      const item = itemOf(event.story_id);
      item.eventCount += 1;
      actorOf(item, actorKeyOfPayload(row.payload)).saved = true;
    } else if (row.topic === 'contribution.created') {
      const payload = row.payload as {
        thread_id: string;
        user_id: string;
        contribution_type: EventContributionType;
        has_citation: boolean;
        accusation_flag: boolean;
      };
      const item = itemOf(payload.thread_id);
      item.eventCount += 1;
      const actor = actorOf(item, payload.user_id);
      actor.contributions[payload.contribution_type] =
        (actor.contributions[payload.contribution_type] ?? 0) + 1;
      // Source-free accusation (WS-E.2.2b): a direct accusation with no
      // citation, tracked at its own contribution type so the v1 hierarchy
      // downweights it at the accusing type's weight. (Linked evidence.added
      // correlation is a WS-G refinement.)
      if (payload.accusation_flag && !payload.has_citation) {
        actor.uncitedAccusationsByType[payload.contribution_type] =
          (actor.uncitedAccusationsByType[payload.contribution_type] ?? 0) + 1;
      }
      // WS-T — a SOURCED contribution earns the positive citation weight (the
      // inverse of the downweight above), tracked at its own contribution type.
      if (payload.has_citation) {
        actor.citedContributionsByType[payload.contribution_type] =
          (actor.citedContributionsByType[payload.contribution_type] ?? 0) + 1;
      }
    } else if (row.topic === 'evidence.added') {
      // Evidence cards count toward window volume; the participation credit
      // flows through the matching contribution.created event (the composer
      // emits both) — counting both here would double-credit one action.
      const payload = row.payload as { thread_id: string };
      itemOf(payload.thread_id).eventCount += 1;
    } else if (row.topic === 'integrity.signal.detected') {
      // Anti-signal counts only: integrity signals describe the window, so
      // they never inflate eventCount (which conditions burst detection).
      const event = row.payload as unknown as IntegritySignalDetectedEvent;
      for (const target of event.target_ids) {
        const item = itemOf(target);
        item.antiSignalCounts[event.signal_type] =
          (item.antiSignalCounts[event.signal_type] ?? 0) + 1;
      }
    }
  }

  // Persist the deduplicated window rows (counts are DISTINCT-ACTOR counts
  // per signal type — one user's repeats count once, WS-E.2.1a acceptance).
  const computedAt = new Date(events.now()).toISOString();
  for (const item of items.values()) {
    let uniqueActiveUsers = 0;
    let sourceOpens = 0;
    let contextOpens = 0;
    let returnVisits = 0;
    const contributionCounts: Record<string, number> = {};
    for (const actor of item.actors.values()) {
      const hasAttention =
        actor.dwellBucket !== 'none' ||
        actor.sawMeaningfulSourceOpen ||
        actor.contextOpened ||
        actor.returnVisitBucket !== 'none' ||
        // A §5.3 save is now a scored participation signal, so a save-only reader
        // IS an active participant — count them here so this durable unique tally
        // matches the realtime HLL (which `recordSave` adds each saver to), and
        // the hourly reconciliation does not flag save-only windows as
        // discrepancies. `uniqueActiveUsers` is a monitoring/reconciliation stat
        // only (never a PWAtt scoring input), so this shifts no ranking.
        actor.saved;
      if (hasAttention) uniqueActiveUsers += 1;
      if (actor.sawMeaningfulSourceOpen) sourceOpens += 1;
      if (actor.contextOpened) contextOpens += 1;
      if (actor.returnVisitBucket !== 'none') returnVisits += 1;
      for (const [type, count] of Object.entries(actor.contributions)) {
        contributionCounts[type] = (contributionCounts[type] ?? 0) + (count ?? 0);
      }
    }
    const record: AggregationWindowRecord = {
      itemId: item.itemId,
      windowStart: fromIso,
      windowSize: size,
      uniqueActiveUsers,
      sourceOpens,
      contextOpens,
      returnVisits,
      contributionCounts,
      antiSignalCounts: { ...item.antiSignalCounts },
      eventCount: item.eventCount,
      computedAt,
    };
    await events.windowStore.upsert(record);
  }

  return { windowStart: fromIso, windowSize: size, items };
}

/**
 * Convert a fold actor into the pure-scoring input shape. `trustWeight`
 * (WS-O.4.5) is the actor's account-age trust factor ∈ [0, 1] — the caller
 * resolves it (the coarse privacy bucket and any unresolvable actor get 1, so
 * anonymity is never penalized); absent ⇒ 1 (no effect).
 */
export function toActorSummary(
  actorKey: string,
  fold: ActorFold,
  trustWeight = 1,
): ActorItemSummary {
  return {
    actor: actorKey,
    dwellBucket: fold.dwellBucket,
    sourceOpened: fold.sawMeaningfulSourceOpen || fold.sawBounceAdjacentOpen,
    sourceBounceOnly: fold.sawBounceAdjacentOpen && !fold.sawMeaningfulSourceOpen,
    contextOpened: fold.contextOpened,
    returnVisitBucket: fold.returnVisitBucket,
    // §5.3 thread traversal (SIG-ATT-TRAVERSE): the deduped max distinct
    // reply-depth bucket the actor reached — now a scored ActiveAttention
    // dimension, no longer collected-then-dropped at the fold boundary.
    replyDepthBucket: fold.branchDepthBucket,
    contributions: fold.contributions,
    uncitedAccusationsByType: fold.uncitedAccusationsByType,
    citedContributionsByType: fold.citedContributionsByType,
    // §5.3 "Save for later" (SIG-ATT-SAVE): 1 when the actor saved the item in
    // the window, else 0. Private by default (the saved COLLECTION never leaves
    // the browser); only this deduped, privacy-leveled boolean is scored.
    savedForLater: fold.saved ? 1 : 0,
    trustWeight,
  };
}
