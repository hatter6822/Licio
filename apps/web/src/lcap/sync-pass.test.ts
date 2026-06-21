// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 — the C0-first sync PASS.  Proves `runC0Sync` POSTs a well-formed,
// frontier-only pulse to /api/lcap/v2/pulse and reads the server's frontier response,
// and that a network/parse failure leaves the outbox intact (returns ok:false, never
// throws).

import {
  buildPulse,
  buildPulseResponse,
  DEFAULT_BUDGET,
  decode,
  encodeWithSchema,
  ldcToPlain,
  pulseResponseV2Schema,
  syncPulseV2Schema,
} from '@licio/lcap';
import { describe, expect, it } from 'vitest';
import { runC0Sync } from './sync-pass.js';

/** A server pulse-response advertising `roomCount` rooms, LDC-encoded for the wire. */
function encodedServerResponse(roomCount: number): Uint8Array {
  const serverPulse = buildPulse({
    nodeId: 'server',
    sessionNonce: new Uint8Array(16),
    transportProfile: 'https',
    privacyMode: 'public',
    budgets: DEFAULT_BUDGET,
    supportedSuites: ['ES256'],
    supportedCompression: ['none'],
    supportedPackVersions: [2],
    checkpointFrontier: Array.from({ length: roomCount }, (_, i) => ({
      room_id_hash: new Uint8Array(32).fill(i + 1),
      latest_tree_size: i + 1,
    })),
    revocationFrontier: [{ scope: 'global', revocation_epoch: 0 }],
  });
  return encodeWithSchema(pulseResponseV2Schema, buildPulseResponse({ pulse: serverPulse }));
}

describe('runC0Sync (WS-R.11.4 C0 pulse)', () => {
  it('POSTs a well-formed client pulse and returns the server room-frontier count', async () => {
    let postedTo: string | undefined;
    let postedBody: Uint8Array | undefined;
    const fetchFn = (async (url: string, init: { body: BodyInit }) => {
      postedTo = url;
      postedBody = new Uint8Array(init.body as ArrayBuffer);
      return new Response(encodedServerResponse(2) as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runC0Sync(fetchFn);
    expect(result).toEqual({ ok: true, roomFrontiers: 2 });
    expect(postedTo).toBe('/api/lcap/v2/pulse');

    // The posted body is a real, frontier-only client pulse (no bulk content).
    const posted = syncPulseV2Schema.parse(ldcToPlain(decode(postedBody as Uint8Array)));
    expect(posted.node_id).toBe('lcap-client');
    expect(posted.checkpoint_frontier).toEqual([]);
    expect(posted.privacy_mode).toBe('public');
  });

  it('returns ok:false on a network failure (the outbox keeps the unsent work)', async () => {
    const fetchFn = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await runC0Sync(fetchFn)).toEqual({ ok: false, roomFrontiers: 0 });
  });

  it('returns ok:false on a non-200 response', async () => {
    const fetchFn = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await runC0Sync(fetchFn)).toEqual({ ok: false, roomFrontiers: 0 });
  });

  it('returns ok:false on an undecodable response body (fail-closed, never throws)', async () => {
    const fetchFn = (async () =>
      new Response(new Uint8Array([0xff, 0xff, 0xff]) as BodyInit, {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await runC0Sync(fetchFn)).toEqual({ ok: false, roomFrontiers: 0 });
  });
});
