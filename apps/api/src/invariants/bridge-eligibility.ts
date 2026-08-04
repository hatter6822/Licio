// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE answer to "may a bridge request be opened on this thread?", for the two
// surfaces that ask it.
//
// The Civic Map publishes bridge targets; `POST /scoi/threads/:id/bridge-requests`
// opens them. They had the SAME question and two implementations, and every
// divergence between them shipped as a control that deterministically failed:
//
//   • the map authorized against the STORY row's room while the endpoint reads
//     the THREAD's — so on any thread that had moved rooms (WS-Q) the map asked
//     about the room the conversation LEFT;
//   • the map never asked whether a request was already open, so a target
//     stayed live and every later click answered `409 already_open`;
//   • the map never asked whether the conversation still ACCEPTS contributions,
//     so an archived thread was offered as a target the endpoint accepted and
//     no member could ever answer — `createContribution` refuses every
//     contribution to it with `thread_archived`.
//
// Three rounds of review, one shape: an eligibility check that re-derives what
// the action enforces drifts from it. So the check lives here, the endpoint
// asks it, the map asks it, and a new bar added to one is added to both.
//
// The COST asymmetry between the two callers is explicit rather than
// accidental. The endpoint answers one thread and may spend a SCOI recompute
// on it; the map asks about every node in the landscape, and recomputing there
// turned a GET into a burst of durable writes — each degraded, each retained
// 365 days, repeated on every refresh. `recompute: false` is what the map
// passes: it consults the STORED baseline only, and a story that has never been
// measured is simply not offered.

import type { EventPipelineServices } from '../events/services.js';
import type { ForumServices } from '../forum/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { ThreadShellRecord } from '../ingestion/stores.js';
import { latestScoiFor, recomputeScoiFor } from './scoi-actions.js';
import type { InvariantPlatformServices } from './services.js';

/** Why a bridge request cannot be opened. The endpoint maps these to statuses;
 *  the map treats every one of them as "no target". */
export type BridgeRefusal = 'not_found' | 'thread_closed' | 'already_open' | 'no_scoi';

export interface BridgeEligibilityDeps {
  forum: ForumServices;
  ingestion: IngestionServices;
  events: EventPipelineServices;
  invariants: InvariantPlatformServices;
}

export interface BridgeActor {
  userId: string;
  roles: readonly string[];
}

export type BridgeEligibility =
  | { ok: true; thread: ThreadShellRecord; baseline: { scoi: number; contextState: string } }
  | { ok: false; reason: BridgeRefusal };

/**
 * A conversation that can still RECEIVE the bridging contribution.
 *
 * A bridge request asks members to answer across a divide, so a thread that
 * accepts no contributions cannot host one: the attempt would be recorded,
 * rendered, and never answerable. These are `createContribution`'s own bars —
 * `archived` is terminal in the WS-G.1.1 graph, and `restricted` is the WS-J
 * safety lock — read here so the offer and the write agree.
 */
export function acceptsContributions(thread: ThreadShellRecord): boolean {
  return thread.conversationState !== 'archived' && thread.safetyState !== 'restricted';
}

/**
 * Whether `actor` may open a bridge request on `threadId`.
 *
 * `recompute: false` (the map) consults only a STORED SCOI baseline and writes
 * nothing; `recompute: true` (the endpoint) may compute and persist one, which
 * is the work a caller who is about to act is entitled to spend.
 */
export async function bridgeEligibility(
  deps: BridgeEligibilityDeps,
  threadId: string,
  actor: BridgeActor,
  options: { recompute: boolean },
): Promise<BridgeEligibility> {
  const thread = await deps.ingestion.stories.getThreadById(threadId);
  if (thread === null) return { ok: false, reason: 'not_found' };

  // ROOM-SCOPED, and the room is the THREAD's. A roomless (global) thread has
  // no steward surface at all, admin included; a room that no longer exists is
  // migration drift; a member-hosted (p2p) stub has no server-side conversation
  // to bridge. All three answer `not_found`, so no read here becomes an
  // existence oracle for a room the caller cannot see.
  const room = thread.roomId === null ? null : await deps.forum.rooms.getById(thread.roomId);
  if (room === null || room.storageMode !== 'server') return { ok: false, reason: 'not_found' };

  const authorized = actor.roles.includes('admin')
    ? true
    : (await deps.forum.rooms.stewardRolesFor(room.roomId, actor.userId)).length > 0;
  if (!authorized) return { ok: false, reason: 'not_found' };

  if (!acceptsContributions(thread)) return { ok: false, reason: 'thread_closed' };

  // Cheap and decisive before anything expensive: one indexed read.
  if (await deps.invariants.bridgeAttempts.openForThread(threadId)) {
    return { ok: false, reason: 'already_open' };
  }

  const stored = await latestScoiFor(deps.events, thread.storyId);
  const baseline =
    stored ??
    (options.recompute
      ? await recomputeScoiFor(deps.invariants, deps.events, thread.storyId)
      : null);
  if (baseline === null) return { ok: false, reason: 'no_scoi' };

  return { ok: true, thread, baseline };
}
