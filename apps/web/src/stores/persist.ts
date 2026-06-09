// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Zod-validated localStorage persistence for Zustand stores (WS-C.1.3a/b). Every
// rehydration is validated through a zod schema; corrupt JSON, a wrong shape, or
// a version mismatch is discarded and the store falls back to its defaults
// (WS-C.1.3 "invalid persisted state is discarded silently"). Writes are
// best-effort: a quota error never throws into the app.
import type { z } from 'zod';

/** All Licio localStorage keys live under this prefix to avoid collisions. */
const KEY_PREFIX = 'licio:';

/** Stored envelope: a version tag plus the persisted slice. */
interface Envelope {
  version: number;
  state: unknown;
}

export interface PersistConfig<T> {
  /** Unprefixed key, e.g. `auth` → `licio:auth`. */
  key: string;
  /** Schema the persisted slice must satisfy on read. */
  schema: z.ZodType<T>;
  /** Bump to invalidate previously stored data when the shape changes. */
  version: number;
}

function storage(): Storage | undefined {
  try {
    if (typeof globalThis === 'undefined') return undefined;
    return globalThis.localStorage ?? undefined;
  } catch {
    // Accessing localStorage can throw (e.g. disabled cookies / sandboxed iframe).
    return undefined;
  }
}

function fullKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

/**
 * Read and validate a persisted slice. Returns `undefined` when storage is
 * unavailable, empty, corrupt, the wrong version, or fails schema validation —
 * and proactively clears anything invalid so a bad value cannot linger.
 */
export function loadPersisted<T>(config: PersistConfig<T>): T | undefined {
  const store = storage();
  if (!store) return undefined;

  const raw = store.getItem(fullKey(config.key));
  if (raw === null) return undefined;

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    store.removeItem(fullKey(config.key));
    return undefined;
  }

  if (typeof envelope !== 'object' || envelope === null || envelope.version !== config.version) {
    store.removeItem(fullKey(config.key));
    return undefined;
  }

  const parsed = config.schema.safeParse(envelope.state);
  if (!parsed.success) {
    store.removeItem(fullKey(config.key));
    return undefined;
  }
  return parsed.data;
}

/** Persist a slice. Best-effort: storage absence or a quota error is swallowed. */
export function savePersisted<T>(config: PersistConfig<T>, state: T): void {
  const store = storage();
  if (!store) return;
  const envelope: Envelope = { version: config.version, state };
  try {
    store.setItem(fullKey(config.key), JSON.stringify(envelope));
  } catch {
    // Quota exceeded or storage disabled — non-fatal; the store stays in memory.
  }
}

/** Remove a persisted slice (e.g. on logout). */
export function clearPersisted(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(fullKey(key));
  } catch {
    // Non-fatal.
  }
}
