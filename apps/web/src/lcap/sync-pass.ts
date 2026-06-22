// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 — the C0-first sync PASS (OFFLINE_SPEC §23.3 / §29.1).  Runs ONE minimal,
// frontier-only pulse against the server: it carries NO bulk content (just the client's
// budgets + an empty/known frontier), POSTs it to /api/lcap/v2/pulse, and decodes the
// server's frontier response so the client learns how far behind it is on each room.
// This is the "minimal C0 exchange" the §23.3 trigger fires; the frontier-diff-driven
// content fetch (wants → exchange → ingest) is the broader sync-wire engine layered on
// top.  Loaded by a DYNAMIC import (from `sync-boot`) so the @licio/lcap codec never
// enters the initial bundle.

import {
  buildPulse,
  DEFAULT_BUDGET,
  decode,
  encodeWithSchema,
  ldcToPlain,
  type PulseResponseV2,
  pulseResponseV2Schema,
  syncPulseV2Schema,
} from '@licio/lcap';

/** The §29.1 C0 frontier-exchange endpoint (same-origin). */
const PULSE_URL = '/api/lcap/v2/pulse';

export interface C0SyncResult {
  /** Whether the pulse round-tripped (a network/parse failure leaves the outbox intact). */
  readonly ok: boolean;
  /** How many room frontiers the server advertised (how many rooms the client may be behind on). */
  readonly roomFrontiers: number;
}

/**
 * Run one minimal C0 pulse against the server (injectable `fetch` for tests).  Builds a
 * tiny frontier-only pulse, POSTs it, and returns the server frontier summary.  Never
 * throws — a failure returns `{ ok: false }` so the trigger orchestrator simply retries
 * on the next event (the unsent work stays in the outbox).
 */
export async function runC0Sync(
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<C0SyncResult> {
  try {
    const sessionNonce = new Uint8Array(16);
    globalThis.crypto.getRandomValues(sessionNonce);
    const pulse = buildPulse({
      nodeId: 'lcap-client',
      sessionNonce,
      transportProfile: 'https',
      privacyMode: 'public',
      budgets: DEFAULT_BUDGET,
      supportedSuites: ['ES256'],
      supportedCompression: ['none', 'gzip', 'deflate'],
      supportedPackVersions: [2],
      // A first-sync client advertises no rooms (it is behind on everything the server
      // holds); the response frontier tells it what to fetch next.
      checkpointFrontier: [],
      revocationFrontier: [{ scope: 'global', revocation_epoch: 0 }],
    });
    const res = await fetchFn(PULSE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/cbor' },
      body: encodeWithSchema(syncPulseV2Schema, pulse) as BodyInit,
    });
    if (!res.ok) return { ok: false, roomFrontiers: 0 };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const response: PulseResponseV2 = pulseResponseV2Schema.parse(ldcToPlain(decode(bytes)));
    return { ok: true, roomFrontiers: response.pulse.checkpoint_frontier.length };
  } catch {
    return { ok: false, roomFrontiers: 0 };
  }
}
