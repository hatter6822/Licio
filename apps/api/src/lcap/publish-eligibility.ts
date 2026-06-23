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

import { type DbExecutor, evidenceCards, rooms, sources, stories } from '@licio/db';
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

function fromStory(
  row: { storageMode: 'server' | 'p2p'; visibility: 'public' | 'room_only' } | undefined,
): TargetEligibility {
  if (!row) return notFound('target_not_found');
  const isServer = row.storageMode === 'server';
  const isPublic = row.visibility === 'public';
  return {
    publishable: isServer && isPublic,
    visibility: isPublic ? 'public' : 'in_room',
    privateRoomCid: !isServer,
    ...(isServer && isPublic ? {} : { reason: isServer ? 'room_only' : 'p2p_room' }),
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
      .select({ storageMode: rooms.storageMode, visibility: stories.visibility })
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
        case 'evidence': {
          const rows = await db
            .select({ storyId: evidenceCards.storyId })
            .from(evidenceCards)
            .where(eq(evidenceCards.evidenceId, target.targetId))
            .limit(1);
          const storyId = rows[0]?.storyId;
          // A card with no story link cannot be proven public ⇒ fail-closed refuse.
          return storyId ? await resolveStory(storyId) : notFound('evidence_unlinked');
        }
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
