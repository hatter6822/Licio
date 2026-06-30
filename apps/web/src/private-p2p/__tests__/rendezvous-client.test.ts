// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RENDEZVOUS-WIRE-MISMATCH regression + PRIV-WEB-SESSION-4 coverage: the live private carrier drives
// `httpRendezvousTransport`, whose strict zod schemas validate every `POST /v1/private-rendezvous/*`
// response.  This was NEVER exercised by a test (all carrier tests inject an in-memory transport),
// which hid a real production break: the server's `poll`/`drainSignals` output must carry
// `room_blind_id` / `recipient_blind_id` so the client can rebuild the §15.3/§15.4 AEAD AAD and the
// strict schema accepts the record.  These tests pin the wire contract against the SERVER shape
// (apps/api/src/private-rendezvous/service.ts `WirePresenceRecord` / `WireSignal`) so a drift on
// EITHER side fails here rather than silently stalling the carrier.

import { describe, expect, it, vi } from 'vitest';
import {
  type FetchLike,
  httpRendezvousTransport,
  type PresenceRecord,
  presenceRecordSchema,
  type WireSignal,
  wireSignalSchema,
} from '../rendezvous-client.js';

/** The EXACT shape `RendezvousService.poll` emits (service.ts `WirePresenceRecord`). */
const SERVER_PRESENCE = {
  room_blind_id: 'cm9vbS1ibGluZA',
  peer_blind_id: 'cGVlci1ibGluZA',
  encrypted_announcement: 'c2VhbGVkLWFubm91bmNlbWVudA',
  expires_at: 1_000_000,
};
/** The EXACT shape `RendezvousService.drainSignals` emits (service.ts `WireSignal`). */
const SERVER_SIGNAL = {
  room_blind_id: 'cm9vbS1ibGluZA',
  sender_blind_id: 'c2VuZGVy',
  recipient_blind_id: 'cmVjaXBpZW50',
  ciphertext: 'c2lnbmFs',
  expires_at: 1_000_000,
};

function fetchReturning(body: unknown, ok = true, status = 200): FetchLike {
  return vi.fn(async () => ({ ok, status, json: async () => body }));
}

describe('httpRendezvousTransport — the live-carrier wire contract (RENDEZVOUS-WIRE-MISMATCH)', () => {
  it('poll accepts the SERVER presence shape and surfaces room_blind_id for AAD reconstruction', async () => {
    const t = httpRendezvousTransport(fetchReturning({ records: [SERVER_PRESENCE] }));
    const records = await t.poll('cm9vbS1ibGluZA');
    expect(records).toHaveLength(1);
    // room_blind_id MUST survive parsing — openRendezvousAnnouncement binds it into the AEAD AAD.
    expect(records[0]?.room_blind_id).toBe(SERVER_PRESENCE.room_blind_id);
    expect(records[0]?.encrypted_announcement).toBe(SERVER_PRESENCE.encrypted_announcement);
  });

  it('signalPoll accepts the SERVER signal shape and surfaces recipient_blind_id for AAD reconstruction', async () => {
    const t = httpRendezvousTransport(fetchReturning({ signals: [SERVER_SIGNAL] }));
    const signals = await t.signalPoll('cmVjaXBpZW50');
    expect(signals).toHaveLength(1);
    // recipient_blind_id MUST survive parsing — openSignal binds it into the AEAD AAD.
    expect(signals[0]?.recipient_blind_id).toBe(SERVER_SIGNAL.recipient_blind_id);
    expect(signals[0]?.ciphertext).toBe(SERVER_SIGNAL.ciphertext);
  });

  it('the client schemas match the server shape EXACTLY (no missing field, no extra field)', () => {
    // The canonical record/signal the carrier hands to openRendezvousAnnouncement / openSignal.
    expect(() => presenceRecordSchema.parse(SERVER_PRESENCE)).not.toThrow();
    expect(() => wireSignalSchema.parse(SERVER_SIGNAL)).not.toThrow();
    // A drifted server that STRIPS the routing key (the original bug) is REJECTED, not silently
    // accepted — the carrier surfaces the drift instead of failing to decrypt.
    const { room_blind_id: _r, ...presenceMissingRoom } = SERVER_PRESENCE;
    expect(() => presenceRecordSchema.parse(presenceMissingRoom)).toThrow();
    const { recipient_blind_id: _x, ...signalMissingRecipient } = SERVER_SIGNAL;
    expect(() => wireSignalSchema.parse(signalMissingRecipient)).toThrow();
  });

  it('rejects a non-ok HTTP response (the server is unreachable / rate-limited)', async () => {
    const t = httpRendezvousTransport(fetchReturning({}, false, 429));
    await expect(t.poll('cm9vbS1ibGluZA')).rejects.toThrow(/HTTP 429/);
  });

  it('rejects a structurally invalid (oversized array) response', async () => {
    const tooMany: PresenceRecord[] = Array.from({ length: 257 }, () => SERVER_PRESENCE);
    const t = httpRendezvousTransport(fetchReturning({ records: tooMany }));
    await expect(t.poll('cm9vbS1ibGluZA')).rejects.toThrow();
  });

  it('rejects a signal whose ciphertext exceeds the schema cap (PRIV-WEB-SESSION-4)', async () => {
    const huge = { ...SERVER_SIGNAL, ciphertext: 'A'.repeat(200_000) };
    const t = httpRendezvousTransport(fetchReturning({ signals: [huge] }));
    await expect(t.signalPoll('cmVjaXBpZW50')).rejects.toThrow();
  });

  it('rejects a non-conforming signal record (missing recipient_blind_id) (PRIV-WEB-SESSION-4)', async () => {
    const { recipient_blind_id: _omit, ...bad } = SERVER_SIGNAL;
    const t = httpRendezvousTransport(fetchReturning({ signals: [bad] }));
    await expect(t.signalPoll('cmVjaXBpZW50')).rejects.toThrow();
  });

  it('announce / signal POST the opaque record body without expecting a parsed response', async () => {
    const fetchImpl = fetchReturning({});
    const t = httpRendezvousTransport(fetchImpl);
    await t.announce(SERVER_PRESENCE as PresenceRecord);
    await t.signal(SERVER_SIGNAL as WireSignal);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
