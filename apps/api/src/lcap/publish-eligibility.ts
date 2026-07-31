// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7 / WS-S.4.4) — SERVER-SIDE publish eligibility.
//
// The public-bridge publish must NOT trust caller-supplied visibility/encryption signals: a
// steward could otherwise assert a `room_only` (or even a p2p-room) item as `public` and pin
// it to the public IPFS DHT.  This resolver DERIVES a content target's REAL visibility +
// storage mode from the live content model, so a block is publishable ONLY if EVERY content
// target resolves to a `public` item in a `server`-storage room (a `source` is a public global
// catalog entry).  Fail-closed: a missing/unlinked/unknown target is NOT publishable, and a
// resolver error refuses rather than proceeds.

import { type DbExecutor, rooms, sources, stories } from '@licio/db';
import { eq } from 'drizzle-orm';
import type { ProvenanceTarget } from './takedown-oracle.js';

/** The server-derived eligibility of one content target. */
export interface TargetEligibility {
  /** True ONLY if this target is a `public` item in a `server`-storage room (or a public source). */
  readonly publishable: boolean;
  /** The derived item visibility; `in_room` ⇒ not publishable. */
  readonly visibility: 'public' | 'in_room';
  /** True if the target's room is a p2p (non-server) room ⇒ never publishable. */
  readonly privateRoomCid: boolean;
  /** A machine reason when not publishable (recorded in the publish audit). */
  readonly reason?: string;
}

/** Resolve a content target's REAL eligibility from the content model (NOT the caller). */
export type PublishEligibilityResolver = (target: ProvenanceTarget) => Promise<TargetEligibility>;

const notFound = (reason: string): TargetEligibility => ({
  publishable: false,
  visibility: 'in_room',
  privateRoomCid: false,
  reason,
});

/** Derive a story target's eligibility from its room storage mode, visibility, AND hidden state
 *  (exported for unit coverage of the fail-closed matrix). */
export function fromStory(
  row:
    | {
        storageMode: 'server' | 'p2p';
        roomVisibility: 'public' | 'private';
        visibility: 'public' | 'room_only';
        hiddenState: unknown;
      }
    | undefined,
): TargetEligibility {
  if (!row) return notFound('target_not_found');
  const isServer = row.storageMode === 'server';
  // THE ROOM'S VISIBILITY IS PART OF THE ITEM'S REAL VISIBILITY.
  //
  // This resolver exists because the publish path must not trust a caller's claim, and
  // it derived the answer from storage mode, story visibility and hidden state — never
  // from whether the ROOM is private.  A story left `public` inside a private room
  // therefore resolved `publishable: true` and could be pinned to the public IPFS DHT.
  //
  // Such a row should not exist: migration 0110's trigger refuses one on any write.
  // But a trigger only fires on a write, and the 0110 backfill deliberately skips rows
  // whose canonical URL already has a live in-room twin — so the rows it cannot convert
  // are exactly the ones nothing revisits.  A derivation that reads the room anyway
  // cannot leak whichever way that is resolved, which is the point of deriving rather
  // than trusting.
  const inPrivateRoom = row.roomVisibility === 'private';
  const isPublic = row.visibility === 'public' && !inPrivateRoom;
  // A story hidden for takedown OR safety is no longer publicly readable (`storyReadableByUser`
  // is false) even though its stored `visibility` may still be `public` — so it must NEVER be
  // pinned to the public DHT.  This complements the takedown oracle, which catches a takedown but
  // NOT a safety hide; the eligibility refuses BOTH.  (`hidden_state IS NULL` ⇒ live.)
  const isLive = row.hiddenState === null;
  const reason = !isServer
    ? 'p2p_room'
    : !isLive
      ? 'hidden'
      : inPrivateRoom
        ? // NAMED SEPARATELY from `room_only`: the story says public and the room says
          // private, which is a stranded row a steward should see, not an ordinary
          // in-room item.
          'private_room'
        : !isPublic
          ? 'room_only'
          : undefined;
  return {
    publishable: isServer && isPublic && isLive,
    visibility: isPublic && isLive ? 'public' : 'in_room',
    privateRoomCid: !isServer,
    ...(reason ? { reason } : {}),
  };
}

/**
 * The production resolver over the live content model.  `story` resolves directly; `evidence`
 * resolves via its `story_id` link; `source` is a public global catalog entry (no room/
 * visibility); any unknown type or unresolvable link is fail-closed not-publishable.
 */
export function drizzlePublishEligibility(db: DbExecutor): PublishEligibilityResolver {
  const resolveStory = async (storyId: string): Promise<TargetEligibility> => {
    const rows = await db
      .select({
        storageMode: rooms.storageMode,
        roomVisibility: rooms.visibility,
        visibility: stories.visibility,
        hiddenState: stories.hiddenState,
      })
      .from(stories)
      .innerJoin(rooms, eq(stories.roomId, rooms.roomId))
      .where(eq(stories.storyId, storyId))
      .limit(1);
    return fromStory(rows[0]);
  };
  return async (target) => {
    try {
      switch (target.targetType) {
        case 'story':
          return await resolveStory(target.targetId);
        case 'source': {
          // A source is a public global catalog entry (no room/visibility) — verify it exists.
          const rows = await db
            .select({ id: sources.sourceId })
            .from(sources)
            .where(eq(sources.sourceId, target.targetId))
            .limit(1);
          return rows[0]
            ? { publishable: true, visibility: 'public', privateRoomCid: false }
            : notFound('target_not_found');
        }
        default:
          return notFound('unknown_target_type');
      }
    } catch {
      return notFound('resolver_error');
    }
  };
}

/**
 * Aggregate the per-target eligibilities into the publish signals.  Publishable ONLY if EVERY
 * target is publishable; the derived visibility is `public` only if ALL are public; a single
 * p2p/room_only target flips the signals so `assertPublicGatewayEligible` refuses the pin.
 */
export function aggregateEligibility(parts: readonly TargetEligibility[]): {
  publishable: boolean;
  visibility: 'public' | 'in_room';
  privateRoomCid: boolean;
  reason?: string;
} {
  if (parts.length === 0)
    return {
      publishable: false,
      visibility: 'in_room',
      privateRoomCid: false,
      reason: 'no_targets',
    };
  const firstBad = parts.find((p) => !p.publishable);
  return {
    publishable: parts.every((p) => p.publishable),
    visibility: parts.every((p) => p.visibility === 'public') ? 'public' : 'in_room',
    privateRoomCid: parts.some((p) => p.privateRoomCid),
    ...(firstBad?.reason ? { reason: firstBad.reason } : {}),
  };
}
