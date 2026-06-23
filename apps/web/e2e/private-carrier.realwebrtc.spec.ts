// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-9 / WS-S.4.3 finding 13 — the REAL-browser private-carrier E2E.  connect-peer.ts
// (discovery → §15.4 sealed signaling → §15.5 membership handshake → the §15.5-step-4
// AEAD-sealed PeerChannel) is unit-proven against a FAKE RTCPeerConnection pair; this
// proves it against a REAL Chromium `RTCPeerConnection`.  Run against the Vite DEV server
// (playwright.realwebrtc.config.ts) so `page.evaluate` can ESM-import the actual carrier +
// `@licio/private-p2p`; the rendezvous is bridged in-page (no server endpoint).  Two real
// peers (A founds the room, B is a second registered device) discover each other, complete
// the handshake over real WebRTC, and exchange a frame end-to-end through the
// membership-proven, session-key-sealed channel.
//
// This test is what surfaced the live-ICE carrier bug: the signaling payload dropped a
// candidate's sdpMid/sdpMLineIndex, which a real addIceCandidate rejects (the fake pc
// accepted anything) — so it is a genuine real-WebRTC regression guard, not a smoke test.

import { expect, test } from '@playwright/test';

test.describe('private carrier over real WebRTC (WP-9, finding 13)', () => {
  test('two members handshake + exchange a frame over a real RTCPeerConnection', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'real WebRTC verified on Chromium');
    await page.goto('/');

    const result = await page.evaluate(async () => {
      try {
        if (typeof RTCPeerConnection !== 'function') return { error: 'no-rtcpeerconnection' };
        // The harness (a /src module Vite serves) re-exports the carrier + dynamically
        // loads @licio/private-p2p (bare specifiers don't resolve from raw page.evaluate).
        const harness = await import('/src/private-p2p/e2e-carrier-harness.ts');
        const { connectPrivatePeer } = harness;
        const p2p = await harness.loadP2p();

        // A founds a room; B is a second device. Both share the epoch keys (the carrier only
        // needs the room/epoch/rendezvous key + each device's signing key + a resolver; the
        // §12.3 join is tested elsewhere).
        const created = await p2p.createPrivateRoom({
          roomId: 'rt-room',
          founderMemberId: 'mem-a',
          founderDeviceId: 'dev-a',
          profile: { name: 'RT', room_type: 'global_topic' },
        });
        const keys = await p2p.deriveRoomEpochKeys(
          created.epochState.roomEpochSecret,
          created.roomIdCommitment,
        );
        const aPub = created.engineParams.bootstrapDevices?.[0]?.signingPublicKey ?? '';
        const bSign = await p2p.generateDeviceSigningKeyPair(false);
        const bPub = p2p.toBase64Url(await p2p.exportPublicKeyRaw(bSign.publicKey));
        const roster: Record<string, { signingPublicKey: string; activeAtEpoch: boolean }> = {
          'dev-a': { signingPublicKey: aPub, activeAtEpoch: true },
          'dev-b': { signingPublicKey: bPub, activeAtEpoch: true },
        };
        const resolveDevice = (id: string) => roster[id];

        // In-page server-blind rendezvous bridge (opaque records/signals shared by both
        // peers; the live server endpoint is tested separately, WS-S.6.6).
        const records: unknown[] = [];
        const signals: unknown[] = [];
        type Rec = { room_blind_id: string; recipient_blind_id?: string };
        const rendezvous = {
          announce: (r: unknown) => {
            records.push(r);
            return Promise.resolve();
          },
          poll: (roomBlindId: string) =>
            Promise.resolve(records.filter((r) => (r as Rec).room_blind_id === roomBlindId)),
          signal: (s: unknown) => {
            signals.push(s);
            return Promise.resolve();
          },
          // DRAIN delivered signals (the real /signal/poll endpoint is deliver-once); else
          // the answerer re-applies the same offer/ICE every poll and the connection stalls.
          signalPoll: (peerBlindId: string) => {
            const mine = signals.filter((s) => (s as Rec).recipient_blind_id === peerBlindId);
            for (const s of mine) {
              const i = signals.indexOf(s);
              if (i >= 0) signals.splice(i, 1);
            }
            return Promise.resolve(mine);
          },
        };

        const base = {
          p2p,
          rendezvous,
          roomIdCommitment: created.roomIdCommitment,
          epoch: Number(created.epochState.epoch),
          rendezvousKey: keys.rendezvousKey,
          resolveDevice,
          transportMode: 'direct_allowed' as const,
          nowMs: () => Date.now(),
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
          timeoutMs: 25_000,
          pollIntervalMs: 60,
        };

        const [a, b] = await Promise.all([
          connectPrivatePeer({
            ...base,
            selfDeviceId: 'dev-a',
            selfSigningKey: created.founder.signingKeyPair.privateKey,
          }),
          connectPrivatePeer({
            ...base,
            selfDeviceId: 'dev-b',
            selfSigningKey: bSign.privateKey,
          }),
        ]);

        // Exchange a frame over the membership-proven, session-key-sealed PeerChannel.
        const got = new Promise<number[]>((resolve) => {
          b.channel.onMessage((f) => resolve(Array.from(f)));
        });
        await Promise.resolve(a.channel.send(new Uint8Array([7, 8, 9])));
        const received = await got;
        a.channel.close();
        b.channel.close();
        return { aPeer: a.peerDeviceId, bPeer: b.peerDeviceId, received };
      } catch (e) {
        return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      }
    });

    expect('error' in result ? result.error : null).toBeNull();
    if (!('error' in result)) {
      // The §15.5 handshake verified each peer's device id, and the frame round-tripped.
      expect(result.aPeer).toBe('dev-b');
      expect(result.bPeer).toBe('dev-a');
      expect(result.received).toEqual([7, 8, 9]);
    }
  });
});
