// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI context surfaces (WS-H.4.1c steward reports, WS-H.4.2d bridge
// routing/credit, WS-H.4.3d moderator context actions).
//
// Everything here is OBSERVATIONAL or additive: annotations are real
// contributions (shared context genuinely pulls lens interpretations
// together — the energy decrease is measured, never assumed), bridge
// credit is recorded on the single-shot bridge-attempt record (never a
// wallet, never a ranking input — the pay-to-rank firewall and the shadow
// discipline both stand), and merge/separate are audited records whose
// physical tree mechanics belong to WS-G/WS-J tooling.

import { randomUUID } from 'node:crypto';
import type { EventPipelineServices } from '../events/services.js';
import type { ForumServices } from '../forum/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { hourWindow, persistComputations, runGuarded } from './runner.js';
import { configSnapshotFor } from './scheduler.js';
import type { InvariantPlatformServices } from './services.js';

/**
 * Re-run SCOI for a story and persist the shadow output; returns the new
 * energy score, or null when the computation degraded. Runs through the
 * SAME runGuarded wrapper as every other invariant call (WS-H.1.2c): the
 * wrapper timeout bounds a route handler or durable consumer that would
 * otherwise hang on a slow embedding provider, health/run metadata are
 * observed, and the persisted row carries the SCOI config snapshot.
 */
export async function recomputeScoiFor(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  storyId: string,
): Promise<{ scoi: number; contextState: string } | null> {
  const config = invariants.config();
  const window = hourWindow(invariants.now());
  const target = { targetType: 'story' as const, targetId: storyId };
  const run = await runGuarded(
    {
      runMetadata: invariants.runMetadata,
      metrics: events.metrics,
      log: invariants.log,
      now: invariants.now,
    },
    'SCOI',
    invariants.scoi.getCard().version,
    'near_realtime',
    target,
    config.wrapperTimeoutMs,
    () => invariants.scoi.computeBatch([target], window),
  );
  if (!run.ok) {
    invariants.scoi.health.observeError();
    return null;
  }
  invariants.scoi.health.observe(run.durationMs, run.outputs);
  await persistComputations(
    events.invariantStore,
    { log: invariants.log, metrics: events.metrics },
    run.outputs,
    configSnapshotFor('SCOI', config),
  );
  const output = run.outputs[0];
  const scoi = output?.score_vector['scoi'];
  const contextState = output?.score_vector['context_state'];
  if (typeof scoi !== 'number' || typeof contextState !== 'string') return null;
  return { scoi, contextState };
}

/** The latest STORED SCOI energy for a story (no compute on read). */
export async function latestScoiFor(
  events: EventPipelineServices,
  storyId: string,
): Promise<{ scoi: number; contextState: string } | null> {
  const row = await events.invariantStore.latest('SCOI', storyId);
  const scoi = row?.scoreVector['scoi'];
  const contextState = row?.scoreVector['context_state'];
  if (typeof scoi !== 'number' || typeof contextState !== 'string') return null;
  return { scoi, contextState };
}

/**
 * Steward context annotation (WS-H.4.3d): ONE system comment per lens that
 * currently carries interpretations on the thread, all with the same shared
 * body (tagged with the lens through `metadata.lens_id`, which is what the
 * SCOI assembly keys on). Mathematically honest mechanism: each lens's
 * interpretation vector is the mean embedding of its contributions, so a
 * SHARED text pulls every vector toward the same point and the Dirichlet
 * energy genuinely decreases — the effect is measured by re-computation,
 * never asserted.
 */
export async function annotateThreadLenses(
  forum: ForumServices,
  threadId: string,
  annotation: string,
): Promise<number> {
  const contributions = await forum.contributions.listByThread(threadId, { limit: 500 });
  const lensIds = new Set<string>();
  for (const contribution of contributions) {
    const lensId = contribution.metadata['lens_id'];
    if (typeof lensId === 'string' && lensId.length > 0) lensIds.add(lensId);
  }
  let inserted = 0;
  for (const lensId of [...lensIds].sort()) {
    // System action (null author); the acting steward is attributed on the
    // audit record and the scoi_context_actions row, which carry the
    // action id this contribution traces back to.
    const result = await forum.contributions.insert({
      contributionId: randomUUID(),
      threadId,
      userId: null,
      type: 'comment',
      body: annotation,
      citations: [],
      metadata: { lens_id: lensId },
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: randomUUID(),
      path: [],
      moderationState: 'published',
    });
    if (result.ok) inserted += 1;
  }
  return inserted;
}

/**
 * Bridge candidates (WS-H.4.2d): users who participate in MULTIPLE
 * overlapping interpretive communities — contributors with published
 * contributions under ≥ 2 distinct lens tags on the thread's room. Ids
 * only; routing produces records for steward visibility (notification
 * dispatch is a later seam — no spam by construction).
 */
export async function bridgeCandidatesFor(
  forum: ForumServices,
  ingestion: IngestionServices,
  threadId: string,
  limit = 10,
): Promise<string[]> {
  const thread = await ingestion.stories.getThreadById(threadId);
  if (!thread) return [];
  const lensesByUser = new Map<string, Set<string>>();
  const collect = async (scopeThreadId: string): Promise<void> => {
    for (const contribution of await forum.contributions.listByThread(scopeThreadId, {
      limit: 500,
    })) {
      const lensId = contribution.metadata['lens_id'];
      if (typeof lensId !== 'string' || lensId.length === 0 || !contribution.userId) continue;
      const set = lensesByUser.get(contribution.userId) ?? new Set<string>();
      set.add(lensId);
      lensesByUser.set(contribution.userId, set);
    }
  };
  await collect(threadId);
  return [...lensesByUser.entries()]
    .filter(([, lenses]) => lenses.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([userId]) => userId);
}

/** A measurable SCOI decrease (absolute) required before credit. */
export const BRIDGE_CREDIT_MIN_DECREASE = 0.02;

/**
 * The bridge-credit consumer (WS-H.4.2d / SCOI-2): a contribution arriving
 * on a thread with an OPEN bridge request triggers SCOI re-computation;
 * when the energy measurably decreases below the request's baseline, the
 * attempt is credited (single-shot) on the bridge-attempt record.
 * Held/system contributions never credit.
 */
export function registerScoiBridgeConsumer(
  events: EventPipelineServices,
  invariants: InvariantPlatformServices,
): void {
  events.router.register({
    name: 'invariant-scoi-bridge',
    topics: ['contribution.created'],
    accessClassifications: ['public'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      const payload = event as unknown as {
        thread_id?: string;
        contribution_id?: string;
        user_id?: string;
      };
      if (!payload.thread_id || !payload.contribution_id || !payload.user_id) return;
      const open = await invariants.bridgeAttempts.openForThread(payload.thread_id);
      if (!open) return;
      const recomputed = await recomputeScoiFor(invariants, events, open.storyId);
      if (!recomputed) return;
      if (recomputed.scoi > open.scoiBaseline - BRIDGE_CREDIT_MIN_DECREASE) return;
      const credited = await invariants.bridgeAttempts.credit(open.attemptId, {
        contributionId: payload.contribution_id,
        bridgeUserId: payload.user_id,
        scoiAfter: recomputed.scoi,
        resolvedAt: new Date(invariants.now()).toISOString(),
      });
      if (!credited) return; // someone else credited first (single-shot)
      events.metrics.increment('invariants.scoi.bridge_credited');
      invariants.log('invariants.scoi.bridge_credited', {
        attempt_id: open.attemptId,
        thread_id: payload.thread_id,
        scoi_before: open.scoiBaseline,
        scoi_after: recomputed.scoi,
      });
    },
  });
}
