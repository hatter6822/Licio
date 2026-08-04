// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.2 user-safety relations: block (bilateral, API-enforced) and mute
// (one-directional viewing filter).  CRUD lives here; ENFORCEMENT is exposed
// through `RelationshipReader` — the seam forum reads (interaction rejection +
// thread viewing filter) and ranking reads (feed viewing filter) at serving
// time, so blocks/mutes are authorization + filtering, never client-only
// (WS-J.1.2a/b).  Lists are private to the owner and never published (§19.5).
import type {
  BlockListResponse,
  BlockRecordView,
  MuteDuration,
  MuteListResponse,
  MuteRecordView,
} from '@licio/shared';
import { decodeKeysetCursor, encodeKeysetCursor } from '../lib/keyset-cursor.js';
import type { ModerationServices } from './services.js';
import type { AccountBlockRecord, AccountMuteRecord } from './stores.js';

const DAY_MS = 86_400_000;

/** Resolve a mute duration to an absolute expiry ISO (null = forever). */
export function muteExpiry(duration: MuteDuration | undefined, nowMs: number): string | null {
  switch (duration) {
    case '1d':
      return new Date(nowMs + DAY_MS).toISOString();
    case '7d':
      return new Date(nowMs + 7 * DAY_MS).toISOString();
    case '30d':
      return new Date(nowMs + 30 * DAY_MS).toISOString();
    default:
      return null; // 'forever' or unspecified
  }
}

/**
 * The relation records this module produces carry NO target handle: the public
 * handle is an identity-store fact, and `relations.ts` owns the moderation store
 * alone.  The ROUTE joins the two planes (`withHandles` in `routes/trust-safety.ts`)
 * before egress validation, which keeps this module free of an identity
 * dependency and keeps the join in one place.
 */
export type BlockRecordCore = Omit<BlockRecordView, 'blocked_user_handle'>;
export type MuteRecordCore = Omit<MuteRecordView, 'muted_user_handle'>;
/** A page of un-decorated records, shaped exactly like the wire response minus
 *  the handle each row gains at the route. */
export type BlockListPage = Omit<BlockListResponse, 'blocks'> & { blocks: BlockRecordCore[] };
export type MuteListPage = Omit<MuteListResponse, 'mutes'> & { mutes: MuteRecordCore[] };

const toBlockView = (r: AccountBlockRecord): BlockRecordCore => ({
  block_id: r.blockId,
  blocked_user_id: r.blockedUserId,
  created_at: r.createdAt,
});

const toMuteView = (r: AccountMuteRecord): MuteRecordCore => ({
  mute_id: r.muteId,
  muted_user_id: r.mutedUserId,
  expires_at: r.expiresAt,
  created_at: r.createdAt,
});

export async function listBlocks(
  services: ModerationServices,
  blockerUserId: string,
  cursor: string | null,
  limit: number,
): Promise<BlockListPage> {
  // The cursor is `(createdAt, blockId)`, not a bare timestamp.  Two blocks made
  // in the same millisecond compare EQUAL on the timestamp alone, so the one the
  // page did not end on was excluded from the next page and never appeared —
  // the list simply lacked it, with a `next_cursor` that looked correct.
  const decoded = decodeKeysetCursor(cursor ?? undefined);
  const rows = await services.blocks.listByBlocker(
    blockerUserId,
    decoded === null ? null : { createdAt: decoded.time, blockId: decoded.id },
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    blocks: page.map(toBlockView),
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeKeysetCursor(last.createdAt, last.blockId)
        : null,
  };
}

export async function createBlock(
  services: ModerationServices,
  blockerUserId: string,
  blockedUserId: string,
): Promise<BlockRecordCore> {
  const record = await services.blocks.insert(blockerUserId, blockedUserId);
  services.metrics.increment('blocks.created');
  return toBlockView(record);
}

export async function removeBlock(
  services: ModerationServices,
  blockId: string,
  ownerUserId: string,
): Promise<boolean> {
  const ok = await services.blocks.delete(blockId, ownerUserId);
  if (ok) services.metrics.increment('blocks.removed');
  return ok;
}

export async function listMutes(
  services: ModerationServices,
  muterUserId: string,
  cursor: string | null,
  limit: number,
): Promise<MuteListPage> {
  // `(createdAt, muteId)` — see `listBlocks` for what the id half prevents.
  const decoded = decodeKeysetCursor(cursor ?? undefined);
  const rows = await services.mutes.listByMuter(
    muterUserId,
    decoded === null ? null : { createdAt: decoded.time, muteId: decoded.id },
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    mutes: page.map(toMuteView),
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeKeysetCursor(last.createdAt, last.muteId)
        : null,
  };
}

export async function createMute(
  services: ModerationServices,
  muterUserId: string,
  mutedUserId: string,
  duration: MuteDuration | undefined,
): Promise<MuteRecordCore> {
  const record = await services.mutes.insert(
    muterUserId,
    mutedUserId,
    muteExpiry(duration, services.now()),
  );
  services.metrics.increment('mutes.created');
  return toMuteView(record);
}

export async function removeMute(
  services: ModerationServices,
  muteId: string,
  ownerUserId: string,
): Promise<boolean> {
  const ok = await services.mutes.delete(muteId, ownerUserId);
  if (ok) services.metrics.increment('mutes.removed');
  return ok;
}

// ---------------------------------------------------------------------------
// Enforcement seam (consumed by forum + ranking at serving time).
// ---------------------------------------------------------------------------

export interface RelationshipSets {
  /** Users the viewer has blocked OR been blocked by (bilateral hide). */
  blocked: Set<string>;
  /** Users the viewer has muted (one-directional hide). */
  muted: Set<string>;
}

export interface RelationshipReader {
  /** The viewer's hide sets (blocked ∪ muted) for content filtering. */
  setsFor(userId: string): Promise<RelationshipSets>;
  /** True when `actorUserId` may NOT interact with `targetUserId` because either
   *  has blocked the other (API-level interaction rejection, WS-J.1.2a). */
  interactionBlocked(actorUserId: string, targetUserId: string): Promise<boolean>;
}

/** The production reader over the moderation stores. */
export function createRelationshipReader(services: ModerationServices): RelationshipReader {
  return {
    async setsFor(userId: string): Promise<RelationshipSets> {
      const [blocked, muted] = await Promise.all([
        services.blocks.blockedSetFor(userId),
        services.mutes.mutedSetFor(userId, new Date(services.now()).toISOString()),
      ]);
      return { blocked, muted };
    },
    async interactionBlocked(actorUserId: string, targetUserId: string): Promise<boolean> {
      if (actorUserId === targetUserId) return false;
      return services.blocks.blockedEitherWay(actorUserId, targetUserId);
    },
  };
}
