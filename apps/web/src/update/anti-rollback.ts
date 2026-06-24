// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — anti-rollback persistence (PRIVATE_SPEC §20.6, §27.5).  The
// verifier's `stale` verdict rejects a manifest whose `release_sequence` is
// below the highest sequence the client has previously TRUSTED.  For that floor
// to be LIVE across reloads (not dead code), the client must persist the
// highest trusted sequence and read it back into the verifier config.
//
// Persistence reuses the WS-C zod-validated `localStorage` layer (`persist.ts`):
// the stored value is a single non-negative integer (the highest trusted release
// sequence).  A corrupt / wrong-shape / wrong-version value is discarded
// silently (the layer's contract), which is fail-SAFE here — losing the floor
// only ever weakens anti-rollback to "no floor yet", never forges a higher one,
// and the floor only ever moves UP (`recordTrustedSequence` writes the max).
//
// This is intentionally NOT a security boundary on its own: a local attacker
// who can write `localStorage` can already tamper with the running app.  It is
// the cross-reload memory that makes a downgrade to a known-vulnerable
// (validly-signed, validly-logged) older bundle visible as `stale` to the same
// device — exactly the rollback the verifier is designed to refuse.

import { z } from 'zod';
import { loadPersisted, savePersisted } from '../stores/persist.js';

const KEY = 'update-anti-rollback';
const VERSION = 1;

/** The persisted slice: the highest release sequence this device has trusted. */
const schema = z.object({
  lastTrustedSequence: z.number().int().nonnegative(),
});

const config = { key: KEY, schema, version: VERSION } as const;

/**
 * Read the highest trusted release sequence persisted on this device, or
 * `undefined` on first run / a discarded (corrupt/old) value.  The verifier
 * treats `undefined` as "no floor" (first run).
 */
export function loadLastTrustedSequence(): number | undefined {
  return loadPersisted(config)?.lastTrustedSequence;
}

/**
 * Record a newly-trusted release sequence.  Monotonic by construction: only
 * persists `sequence` when it is at least the stored floor, so the floor never
 * moves backward (a replayed older-but-valid manifest cannot lower it).
 */
export function recordTrustedSequence(sequence: number): void {
  if (!Number.isInteger(sequence) || sequence < 0) return;
  const current = loadLastTrustedSequence() ?? -1;
  if (sequence < current) return;
  savePersisted(config, { lastTrustedSequence: sequence });
}
