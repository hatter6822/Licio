// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.3 — a content-free summary of the LCAP client's REAL offline state, read from
// the `lcap_v2` IndexedDB stores so the offline page can surface honest §20 outbox /
// §25 conflict state instead of a fabricated signal.  It reports:
//   - the durable §20 outbox posture (queued / retrying / exported) for the records that
//     have not yet propagated, derived from the outbox rows' status;
//   - whether any fork evidence is held (§25 device/checkpoint conflict).
// It returns NO record content — only counts + a coarse state — so the surface stays
// content-free and accessible.  It reads the local stores directly (no `@licio/lcap`
// codec import), keeping the always-available surface off the lazy bundle-codec chunk.

import { z } from 'zod';
import { getLcapDb, LCAP_STORE } from './db.js';
import { collectByCursor } from './store.js';

/** The honest §20 outbox state for an unpropagated record (mirrors `OutboxStatus`). */
export type OutboxLocalState = 'queued' | 'retrying' | 'exported';

/** One outbox row's relevant fields (validated at the read boundary; extra keys ignored). */
const outboxRowSchema = z.object({
  status: z.enum(['queued', 'retrying', 'exported', 'sent', 'accepted']).optional(),
  retries: z.number().int().nonnegative().optional(),
});

/** A content-free summary of the local offline state for the offline page. */
export interface OfflineStatusSummary {
  /** Count of records in each honest §20 outbox state (0 when the outbox is empty). */
  readonly outbox: Readonly<Record<OutboxLocalState, number>>;
  /** The highest retry attempt observed among retrying rows (for the chip's attempt). */
  readonly maxRetryAttempt: number;
  /** Whether any §25 device-fork evidence is held locally (a conflict to inspect). */
  readonly hasConflict: boolean;
}

const EMPTY: OfflineStatusSummary = {
  outbox: { queued: 0, retrying: 0, exported: 0 },
  maxRetryAttempt: 0,
  hasConflict: false,
};

/** Map a raw outbox status to the honest §20 chip state (unknown/sent → not surfaced). */
function toOutboxState(status: string | undefined, retries: number): OutboxLocalState | null {
  if (status === 'exported') return 'exported';
  if (status === 'retrying' || (status === 'queued' && retries > 0)) return 'retrying';
  if (status === 'queued' || status === undefined) return 'queued';
  return null; // sent / accepted → propagated, no outbox chip
}

/**
 * Summarize the local offline state (bounded read).  Returns the empty summary when
 * IndexedDB is unavailable or the stores are empty, so the caller never throws.
 */
export async function readOfflineStatus(limit = 500): Promise<OfflineStatusSummary> {
  let db: IDBDatabase;
  try {
    db = await getLcapDb();
  } catch {
    return EMPTY;
  }
  const outbox: Record<OutboxLocalState, number> = { queued: 0, retrying: 0, exported: 0 };
  let maxRetryAttempt = 0;
  try {
    const rows = await collectByCursor<unknown>(db, LCAP_STORE.outbox, limit);
    for (const raw of rows) {
      const parsed = outboxRowSchema.safeParse(raw);
      if (!parsed.success) continue;
      const retries = parsed.data.retries ?? 0;
      const state = toOutboxState(parsed.data.status, retries);
      if (!state) continue;
      outbox[state] += 1;
      if (state === 'retrying') maxRetryAttempt = Math.max(maxRetryAttempt, retries);
    }
  } catch {
    // A read failure leaves the empty outbox summary; never throw to the surface.
  }
  let hasConflict = false;
  try {
    // Any quarantined record whose reason is a fork is a §25 conflict to inspect.
    const quarantined = await collectByCursor<{ reason?: unknown }>(
      db,
      LCAP_STORE.quarantine,
      limit,
    );
    hasConflict = quarantined.some(
      (row) => typeof row.reason === 'string' && row.reason.includes('fork'),
    );
  } catch {
    // ignore — conflict detection is best-effort.
  }
  return { outbox, maxRetryAttempt, hasConflict };
}
