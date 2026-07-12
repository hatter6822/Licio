// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate-arena maintenance scheduler (the house lease-guarded pattern, like
// governance/scheduler.ts): every instance ticks on a short interval; a Postgres
// job lease grants at most one executor per window.  The tick locks every arena
// whose material is due to lock in (the 23h schedule or the both-sides-idle
// expedited path), drains the AI resolution queue (through the governed
// adjudicator — the room's ratified agent where the WS-U `debate.judge`
// capability is granted, else the platform legs), and finalizes every arena
// whose 24h steward-override window has closed (tagging the loser `incorrect`).
// The judge runner is assembled over the ai-governance guard + model legs +
// AIOutputRecord; if AI governance is not configured, the runner is fail-closed
// (a null verdict resolves `inconclusive`, so nothing is tagged).
import { hostname } from 'node:os';
import { adjudicateDebate } from '../ai-governance/debate.js';
import { tryGetAiGovernanceServices } from '../ai-governance/services.js';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { getIngestionServices, type IngestionServices } from '../ingestion/services.js';
import {
  type DebateDeps,
  type DebateJudgeRunner,
  runDebateLifecycle,
  type StoryContentReader,
} from './debate.js';
import { type ForumServices, getForumServices } from './services.js';

export const DEBATE_JOB_LEASE = 'forum_debate_lifecycle';
/** 5 minutes: responsive enough for the 1h/23h/24h windows without hammering. */
export const DEBATE_SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;

/** The governed adjudicator runner over the ai-governance guard + model legs.
 *  When the boot wired an LLM backend, `llmDebateJudge` is the primary leg
 *  (WS-T challenge resolution — the production default) and the deterministic
 *  MLP the per-call fail-closed fallback inside `adjudicateDebate`.  A
 *  governed room whose ratified agent holds the WS-U `debate.judge`
 *  capability adjudicates its own queue: the room leg conditions the SAME
 *  governed LLM machinery on the room's ratified prompt (resolved inside
 *  `adjudicateDebate`'s deps via `roomConditioning`). */
export function buildDebateJudgeRunner(now: () => number): DebateJudgeRunner {
  return async (context, input) => {
    const aiGov = tryGetAiGovernanceServices();
    if (aiGov === null) return null; // fail-closed → inconclusive
    // WS-U `debate.judge`: a governed room whose ratified agent holds the
    // capability adjudicates its own queue (deny-by-default; every failure
    // resolves null and the platform legs adjudicate instead).
    const room =
      context.roomId === null ? null : await resolveRoomDebateConditioning(context.roomId);
    const outcome = await adjudicateDebate(
      {
        guard: aiGov.guard,
        outputRecords: aiGov.outputRecords,
        now,
        llmJudge: aiGov.llmDebateJudge,
        roomConditioning: room,
      },
      context.debateId,
      input,
    );
    if (!outcome.ok) return null;
    // A room-agent verdict lands in the WS-U agent action log (the provenance
    // triple; reversible — the steward's 24h overrule is the human remedy).
    if (outcome.viaRoomAgent && room !== null) {
      await recordRoomDebateAction(room, context.debateId, outcome.verdict);
    }
    return { verdict: outcome.verdict, outputId: outcome.outputId };
  };
}

/** Resolve the WS-U room conditioning; null when governance is not wired
 *  (tests / partial boots) or the room's binding doesn't grant the judge. */
async function resolveRoomDebateConditioning(roomId: string) {
  try {
    const { getGovernanceService } = await import('../governance/services.js');
    return await getGovernanceService().debateConditioning(roomId);
  } catch {
    return null;
  }
}

/** Best-effort agent-action append (the verdict itself is already durable on
 *  the arena row + its AIOutputRecord; a log fault must not void it).  The
 *  provenance comes from the CONDITIONING that judged, never a re-read — a
 *  binding swapped mid-judgement must not be credited with this verdict. */
async function recordRoomDebateAction(
  room: { roomId: string; modelId: string; promptHash: string },
  debateId: string,
  verdict: { verdict: string; winner: string; rationale: string },
): Promise<void> {
  try {
    const { getGovernanceService } = await import('../governance/services.js');
    await getGovernanceService().recordDebateAgentAction({
      roomId: room.roomId,
      debateId,
      verdict: verdict.verdict,
      winner: verdict.winner,
      rationale: verdict.rationale,
      modelId: room.modelId,
      promptHash: room.promptHash,
    });
  } catch {
    // Best-effort by design.
  }
}

/** A story's debatable material over the WS-F story store: the native-post
 *  body (or the extraction excerpt) + the canonical URL as the primary
 *  citation.  A missing or hidden (takedown/safety) story reads null — the
 *  arena never re-serves a hidden story's content. */
export function buildStoryContentReader(stories: IngestionServices['stories']): StoryContentReader {
  return async (storyId) => {
    const story = await stories.getById(storyId);
    if (!story || story.hiddenState !== null) return null;
    const body =
      story.submissionMetadata.submission_type === 'original_brief'
        ? story.submissionMetadata.body
        : (story.excerpt ?? '');
    return {
      title: story.title,
      body,
      citations: story.canonicalUrl !== null ? [{ url: story.canonicalUrl }] : [],
      updatedAt: story.lastMaterialUpdateAt,
    };
  };
}

/**
 * Assemble the full arena deps over a forum + ingestion service pair — the
 * ONE assembly every debate call site uses (the scheduler tick, the forum
 * routes, the contribution create/edit/remove hooks, and the dev simulator),
 * so window scoping, story-content reads, and the ranking-feature refresh on
 * a story dispute change never diverge between paths.
 */
export function buildDebateDeps(forum: ForumServices, ingestion: IngestionServices): DebateDeps {
  return {
    debates: forum.debates,
    contributions: forum.contributions,
    storyAuthor: async (sid) => (await ingestion.stories.getById(sid))?.submittedBy ?? null,
    storyContent: buildStoryContentReader(ingestion.stories),
    isSteward: async (roomId, uid) => (await forum.rooms.stewardRolesFor(roomId, uid)).length > 0,
    setStoryDispute: async (sid, status) => {
      await ingestion.stories.update(sid, { disputeStatus: status });
      // WS-T — when a debate outcome tags a story `incorrect` (or clears it), the
      // feed's `dispute_penalty` reads the STORED ranking feature vector, which is
      // otherwise only refreshed on an invariant/integrity event or the hourly
      // batch.  Refresh it now so the demotion takes effect immediately (lazy
      // import avoids a static forum→ranking module cycle).
      const ranking = await import('../ranking/services.js');
      await ranking.refreshStoryFeaturesBestEffort(sid);
    },
    // The injectable ForumServices seam (boot assigns the real governed
    // runner; tests/e2e may inject) — every call site judges through it.
    runJudge: forum.debateJudge,
    broadcast: (id, arena) => forum.debateBroadcaster.publish(id, arena),
    windows: forum.debateWindowsOverride ?? undefined,
    now: forum.now,
    log: forum.log,
  };
}

/** Assemble the arena deps over the running forum + ingestion + ai services. */
export function buildDebateSchedulerDeps(): DebateDeps {
  return buildDebateDeps(getForumServices(), getIngestionServices());
}

/** The judge pass may spend at most this fraction of the scheduler interval —
 *  comfortably inside the 0.9×interval job lease, so a slow-LLM backlog can
 *  never judge past the lease another instance may then hold (arenas left over
 *  simply wait for the next tick; the verdict CAS covers any residual race). */
export const DEBATE_JUDGE_LEASE_FRACTION = 0.75;

/** One scheduler tick; exported for tests and manual recovery. `judgeBudgetMs`
 *  bounds the judge pass's wall clock (default: the lease-derived fraction). */
export async function runDebateSchedulerTick(
  onError: (err: unknown) => void = () => {},
  judgeBudgetMs: number = Math.ceil(DEBATE_SCHEDULER_INTERVAL_MS * DEBATE_JUDGE_LEASE_FRACTION),
): Promise<void> {
  try {
    const deps = buildDebateSchedulerDeps();
    const { locked, expedited, judged, finalized } = await runDebateLifecycle(
      deps,
      undefined,
      undefined,
      deps.now() + judgeBudgetMs,
    );
    if (locked > 0 || expedited > 0 || judged > 0 || finalized > 0) {
      deps.log('forum.debate_lifecycle', { locked, expedited, judged, finalized });
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
