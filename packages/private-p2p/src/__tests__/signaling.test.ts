// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.2 — encrypted signaling tests (PRIVATE_SPEC §15.4): the seal→route→open
// round-trip; the server sees ONLY opaque blind ids + ciphertext (no SDP/ICE);
// AAD-bound routing fields + cross-room channel-key isolation reject tampering;
// strict payload validation; and the relay-only ICE suppression (candidate-type
// parsing + filtering).
import { describe, expect, it } from 'vitest';
import { randomBytes } from '../crypto/runtime.js';
import {
  type EncryptedSignal,
  filterIceCandidatesForMode,
  iceCandidateAllowed,
  iceCandidateType,
  openSignal,
  type SignalingPayload,
  scrubRelatedAddress,
  sealSignal,
  signalingPayloadSchema,
} from '../sync/signaling.js';

const channelKey = randomBytes(32);
const routing = {
  roomBlindId: 'cm9vbQ',
  senderBlindId: 'c2VuZGVy',
  recipientBlindId: 'cmVjaXA',
  expiresAt: 1_000_000,
};
const offer: SignalingPayload = {
  schema: 'licio.private.signaling_payload.v1',
  kind: 'offer',
  sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
};

describe('seal/open round-trip (§15.4)', () => {
  it('round-trips a payload through an EncryptedSignal', async () => {
    const signal = await sealSignal(offer, channelKey, routing);
    expect(signal.room_blind_id).toBe(routing.roomBlindId);
    expect(await openSignal(signal, channelKey)).toStrictEqual(offer);
  });

  it('the server-visible blob carries NO SDP/ICE (only opaque fields)', async () => {
    const signal = await sealSignal(offer, channelKey, routing);
    const keys = Object.keys(signal).sort();
    expect(keys).toStrictEqual([
      'ciphertext',
      'expires_at',
      'recipient_blind_id',
      'room_blind_id',
      'sender_blind_id',
    ]);
    // The SDP must not appear anywhere in the serialized blob.
    expect(JSON.stringify(signal)).not.toContain('v=0');
  });

  it('fails to open under the wrong channel key (cross-room isolation)', async () => {
    const signal = await sealSignal(offer, channelKey, routing);
    await expect(openSignal(signal, randomBytes(32))).rejects.toThrow();
  });

  it('fails to open if ANY AAD-bound routing field is tampered (PRIV-SYNC-4)', async () => {
    const signal = await sealSignal(offer, channelKey, routing);
    // EVERY routing field is AAD-bound, so tampering ANY of them must fail the open (not just one).
    const mutations: Array<Partial<EncryptedSignal>> = [
      { room_blind_id: 'b3RoZXItcm9vbQ' },
      { sender_blind_id: 'b3RoZXItc2VuZGVy' },
      { recipient_blind_id: 'b3RoZXItcmVjaXBpZW50' },
      { expires_at: signal.expires_at + 1 },
    ];
    for (const mutation of mutations) {
      await expect(openSignal({ ...signal, ...mutation }, channelKey)).rejects.toThrow();
    }
  });

  it('round-trips an ICE candidate and a bye', async () => {
    const ice: SignalingPayload = {
      schema: 'licio.private.signaling_payload.v1',
      kind: 'ice',
      ice_candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host',
    };
    const bye: SignalingPayload = { schema: 'licio.private.signaling_payload.v1', kind: 'bye' };
    expect(await openSignal(await sealSignal(ice, channelKey, routing), channelKey)).toStrictEqual(
      ice,
    );
    expect(await openSignal(await sealSignal(bye, channelKey, routing), channelKey)).toStrictEqual(
      bye,
    );
  });
});

describe('payload validation', () => {
  it('an offer requires an SDP; an ice requires a candidate', () => {
    expect(() =>
      signalingPayloadSchema.parse({
        schema: 'licio.private.signaling_payload.v1',
        kind: 'offer',
      }),
    ).toThrow();
    expect(() =>
      signalingPayloadSchema.parse({
        schema: 'licio.private.signaling_payload.v1',
        kind: 'ice',
      }),
    ).toThrow();
  });
});

describe('relay-only ICE suppression (§15.4)', () => {
  const host = 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host';
  const srflx =
    'candidate:2 1 udp 1686052607 198.51.100.1 50000 typ srflx raddr 192.0.2.1 rport 54321';
  const relay =
    'candidate:3 1 udp 41885439 203.0.113.5 60000 typ relay raddr 198.51.100.1 rport 50000';

  it('parses the candidate type', () => {
    expect(iceCandidateType(host)).toBe('host');
    expect(iceCandidateType(srflx)).toBe('srflx');
    expect(iceCandidateType(relay)).toBe('relay');
    expect(iceCandidateType('garbage')).toBeUndefined();
  });

  it('relay-only permits only relay candidates (fail-closed on unknown)', () => {
    expect(iceCandidateAllowed('relay_only', 'host')).toBe(false);
    expect(iceCandidateAllowed('relay_only', 'srflx')).toBe(false);
    expect(iceCandidateAllowed('relay_only', 'relay')).toBe(true);
    expect(iceCandidateAllowed('relay_only', undefined)).toBe(false);
    // direct mode allows everything.
    expect(iceCandidateAllowed('direct_allowed', 'host')).toBe(true);
  });

  it('filters a candidate list per mode (IP-revealing types dropped in relay-only)', () => {
    // In relay-only the surviving relay candidate ALSO has its raddr/rport scrubbed (PRIV-SYNC-3).
    const relayScrubbed =
      'candidate:3 1 udp 41885439 203.0.113.5 60000 typ relay raddr 0.0.0.0 rport 0';
    expect(filterIceCandidatesForMode('relay_only', [host, srflx, relay])).toStrictEqual([
      relayScrubbed,
    ]);
    // direct mode passes everything verbatim (no scrub).
    expect(filterIceCandidatesForMode('direct_allowed', [host, srflx, relay])).toStrictEqual([
      host,
      srflx,
      relay,
    ]);
  });

  it('scrubs the raddr/rport related-address on a relay candidate (PRIV-SYNC-3)', () => {
    const scrubbed = scrubRelatedAddress(relay);
    expect(scrubbed).toContain('typ relay');
    expect(scrubbed).toContain('raddr 0.0.0.0');
    expect(scrubbed).toContain('rport 0');
    expect(scrubbed).not.toContain('198.51.100.1'); // the host's related address is gone
    expect(scrubbed).not.toContain('rport 50000');
  });
});
