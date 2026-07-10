// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate-arena maintenance scheduler (the house lease-guarded pattern, like
// governance/scheduler.ts): every instance ticks on a short interval; a Postgres
// job lease grants at most one executor per window.  The tick judges every arena
// whose 12h edit window has closed (through the governed adjudicator) and
// finalizes every arena whose 24h steward-override window has closed (tagging the
// loser `incorrect`).  The judge runner is assembled over the ai-governance guard
// + neural model + AIOutputRecord; if AI governance is not configured, the runner
// is fail-closed (a null verdict resolves `inconclusive`, so nothing is tagged).
import { hostname } from 'node:os';
import { adjudicateDebate } from '../ai-governance/debate.js';
import { tryGetAiGovernanceServices } from '../ai-governance/services.js';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { getIngestionServices } from '../ingestion/services.js';
import { type DebateDeps, type DebateJudgeRunner, runDebateLifecycle } from './debate.js';
import { getForumServices } from './services.js';

export const DEBATE_JOB_LEASE = 'forum_debate_lifecycle';
/** 5 minutes: responsive enough for the 12h/24h windows without hammering. */
export const DEBATE_SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;

/** The governed adjudicator runner over the ai-governance guard + neural model.
 *  When the boot wired an LLM backend, `llmDebateJudge` is the primary leg
 *  (WS-T challenge resolution — the production default) and the deterministic
 *  MLP the per-call fail-closed fallback inside `adjudicateDebate`. */
export function buildDebateJudgeRunner(now: () => number): DebateJudgeRunner {
  return async (debateId, input) => {
    const aiGov = tryGetAiGovernanceServices();
    if (aiGov === null) return null; // fail-closed → inconclusive
    const outcome = await adjudicateDebate(
      {
        guard: aiGov.guard,
        outputRecords: aiGov.outputRecords,
        now,
        llmJudge: aiGov.llmDebateJudge,
      },
      debateId,
      input,
    );
    return outcome.ok ? { verdict: outcome.verdict, outputId: outcome.outputId } : null;
  };
}

/** Assemble the full arena deps over the running forum + ingestion + ai services. */
export function buildDebateSchedulerDeps(): DebateDeps {
  const forum = getForumServices();
  const ingestion = getIngestionServices();
  return {
    debates: forum.debates,
    contributions: forum.contributions,
    storyAuthor: async (sid) => (await ingestion.stories.getById(sid))?.submittedBy ?? null,
    isSteward: async (roomId, uid) => (await forum.rooms.stewardRolesFor(roomId, uid)).length > 0,
    setStoryDispute: async (sid, status) => {
      await ingestion.stories.update(sid, { disputeStatus: status });
      // WS-T — when `finalizeDebate` tags a story `incorrect` (or clears it), the
      // feed's `dispute_penalty` reads the STORED ranking feature vector, which is
      // otherwise only refreshed on an invariant/integrity event or the hourly
      // batch.  Refresh it now so the demotion takes effect immediately (lazy
      // import avoids a static forum→ranking module cycle).
      const ranking = await import('../ranking/services.js');
      await ranking.refreshStoryFeaturesBestEffort(sid);
    },
    runJudge: buildDebateJudgeRunner(forum.now),
    broadcast: (id, arena) => forum.debateBroadcaster.publish(id, arena),
    windows: forum.debateWindowsOverride ?? undefined,
    now: forum.now,
    log: forum.log,
  };
}

/** One scheduler tick; exported for tests and manual recovery. */
export async function runDebateSchedulerTick(
  onError: (err: unknown) => void = () => {},
): Promise<void> {
  try {
    const deps = buildDebateSchedulerDeps();
    const { judged, finalized } = await runDebateLifecycle(deps);
    if (judged > 0 || finalized > 0) {
      deps.log('forum.debate_lifecycle', { judged, finalized });
    }
  } catch (err) {
    onError(err);
  }
}

/** Start the interval runner (lease-guarded in production). */
export function startDebateScheduler(
  onError: (err: unknown) => void = () => {},
  intervalMs: number = DEBATE_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const timer = setInterval(async () => {
    if (!runner) {
      await runDebateSchedulerTick(onError);
      return;
    }
    const acquired = await runner.lease.tryAcquire(
      DEBATE_JOB_LEASE,
      Math.ceil(intervalMs * 0.9),
      runner.holder ?? hostname(),
    );
    if (acquired) await runDebateSchedulerTick(onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
