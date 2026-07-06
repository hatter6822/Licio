// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room vantage store (WS-G.2.2 "declare-once" interpretation lens). A member
// declares the lens they are reading a room through ONCE; the comment composer
// then pre-selects it for every comment in that room, editable per comment. This
// is purely a local UI convenience that pre-fills a field — the authoritative
// `lens_id` tag on each contribution is still validated server-side against the
// room's lenses (WS-G §15.2). A lens is an interpretation CONTEXT, never a
// faction or a vote, so this is not an applause affordance.
//
// Persisted (zod-validated on rehydration; an invalid slice is discarded) and
// bounded so it cannot grow without limit across many visited rooms.
import { z } from 'zod';
import { create } from 'zustand';
import { loadPersisted, type PersistConfig, savePersisted } from './persist.js';

/** Most recent rooms whose vantage we remember; older entries are evicted. */
const MAX_ROOMS = 50;

const vantagePersistedSchema = z.object({
  /** roomId → chosen lensId. */
  byRoom: z.record(z.string().uuid(), z.string().uuid()),
});
type VantagePersisted = z.infer<typeof vantagePersistedSchema>;

const PERSIST: PersistConfig<VantagePersisted> = {
  key: 'room-vantage',
  schema: vantagePersistedSchema,
  version: 1,
};

const DEFAULTS: VantagePersisted = { byRoom: {} };

export interface RoomVantageState extends VantagePersisted {
  /** The remembered lens for a room, or null if none is declared. */
  getVantage: (roomId: string) => string | null;
  /** Declare (or, with null, clear) the vantage lens for a room. */
  setVantage: (roomId: string, lensId: string | null) => void;
}

/** Cap the map so long-lived localStorage cannot accumulate unboundedly. */
function bounded(byRoom: Record<string, string>): Record<string, string> {
  const keys = Object.keys(byRoom);
  if (keys.length <= MAX_ROOMS) return byRoom;
  const trimmed: Record<string, string> = {};
  for (const key of keys.slice(keys.length - MAX_ROOMS)) {
    const value = byRoom[key];
    if (value !== undefined) trimmed[key] = value;
  }
  return trimmed;
}

export const useRoomVantageStore = create<RoomVantageState>((set, get) => ({
  ...(loadPersisted(PERSIST) ?? DEFAULTS),
  getVantage: (roomId) => get().byRoom[roomId] ?? null,
  setVantage: (roomId, lensId) => {
    const next = { ...get().byRoom };
    // Always remove first so a re-declared room RE-INSERTS at the tail: JS keeps
    // a string key's position on value update, so without this a daily-used room
    // could be evicted as "oldest" despite being just re-declared. Delete-then-
    // append makes {@link bounded}'s keep-last-N a true LRU (recency of set).
    delete next[roomId];
    if (lensId !== null) next[roomId] = lensId;
    const byRoom = bounded(next);
    set({ byRoom });
    savePersisted(PERSIST, { byRoom });
  },
}));
