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

  // WS-S.4.3 — full §15.7 op-exchange CONVERGENCE over a real Chromium data channel: a fresh
  // member (B) walks the DAG from A and reaches BYTE-IDENTICAL reduced state.  The fake-RTC
  // unit test proves the convergence math; this proves it over a real RTCDataChannel + the
  // now-persistent maintenance signaling loop.
  test('a fresh member converges to byte-identical state over real WebRTC', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'real WebRTC verified on Chromium');
    await page.goto('/');

    const result = await page.evaluate(async () => {
      try {
        if (typeof RTCPeerConnection !== 'function') return { error: 'no-rtcpeerconnection' };
        const harness = await import('/src/private-p2p/e2e-carrier-harness.ts');
        const { connectPrivatePeer, PrivateSyncSession } = harness;
        const p2p = await harness.loadP2p();

        const created = await p2p.createPrivateRoom({
          roomId: 'rt-conv',
          founderMemberId: 'mem-a',
          founderDeviceId: 'dev-a',
          profile: { name: 'Conv', room_type: 'global_topic' },
        });
        const roomIdCommitment = created.roomIdCommitment;
        const epoch = Number(created.epochState.epoch);
        const keys = await p2p.deriveRoomEpochKeys(
          created.epochState.roomEpochSecret,
          roomIdCommitment,
        );

        // A authors the genesis + a story; B is a fresh second device sharing the room keys.
        const alice = await p2p.PrivateRoomEngine.load({
          ...created.engineParams,
          storage: new p2p.InMemoryPrivateRoomStorage(),
        });
        await alice.applyLocalOp(created.genesisOp, created.sealParams);
        const story = await p2p.buildRoomOp(
          {
            roomId: 'rt-conv',
            roomIdCommitment,
            epochState: created.epochState,
            author: {
              memberId: 'mem-a',
              deviceId: 'dev-a',
              signingKey: created.founder.signingKeyPair.privateKey,
              seq: alice.nextAuthorSeq('dev-a'),
            },
            opId: crypto.randomUUID(),
            parents: alice.heads(),
            lamport: alice.nextLamport(),
          },
          {
            type: 'story.create',
            story_id: 'conv-story',
            thread_id: 't1',
            title: 'converged over real WebRTC',
            submission_type: 'original_brief',
            topic_ids: [],
            submission_metadata: {},
          },
        );
        await alice.applyLocalOp(story.op, story.sealParams);
        const bob = await p2p.PrivateRoomEngine.load({
          ...created.engineParams,
          storage: new p2p.InMemoryPrivateRoomStorage(),
        });

        const aPub = created.engineParams.bootstrapDevices?.[0]?.signingPublicKey ?? '';
        const bSign = await p2p.generateDeviceSigningKeyPair(false);
        const bPub = p2p.toBase64Url(await p2p.exportPublicKeyRaw(bSign.publicKey));
        const roster: Record<string, { signingPublicKey: string; activeAtEpoch: boolean }> = {
          'dev-a': { signingPublicKey: aPub, activeAtEpoch: true },
          'dev-b': { signingPublicKey: bPub, activeAtEpoch: true },
        };
        const resolveDevice = (id: string) => roster[id];

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
          roomIdCommitment,
          epoch,
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

        // The codec `PrivateSyncSession` requires — the SAME three members
        // `room-manager.ts` wires in production.  `chunkOpResponse` is not
        // optional: `onRequest` calls it to batch the served envelopes, so a stub
        // without it threw a TypeError inside the frame handler, which the
        // session reports through `onError` — unset here — and therefore
        // SWALLOWED.  The responder simply went quiet, the requester waited out
        // its 15s convergence loop, and the failure looked like "sync does not
        // converge" rather than "the test's codec is incomplete".  This code runs
        // inside `page.evaluate`, so TypeScript never checked the stub against
        // the interface that documents the member as REQUIRED.
        const codec = {
          encodeSyncMessage: p2p.encodeSyncMessage,
          decodeSyncMessage: p2p.decodeSyncMessage,
          chunkOpResponse: p2p.chunkOpResponseEnvelopes,
        };
        const sa = new PrivateSyncSession(alice, a.channel, codec);
        const sb = new PrivateSyncSession(bob, b.channel, codec);
        sa.start();
        sb.start();

        // Wait for B to converge to A's commitment (bounded).
        const commitA = Array.from(p2p.roomStateCommitment(alice.state()));
        let converged = false;
        for (let i = 0; i < 600; i++) {
          const commitB = Array.from(p2p.roomStateCommitment(bob.state()));
          if (commitB.length === commitA.length && commitB.every((x, j) => x === commitA[j])) {
            converged = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        const gotStory = bob.state().stories.get('conv-story')?.title ?? null;
        sa.close();
        sb.close();
        a.channel.close();
        b.channel.close();
        return { converged, gotStory };
      } catch (e) {
        return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      }
    });

    expect('error' in result ? result.error : null).toBeNull();
    if (!('error' in result)) {
      expect(result.converged).toBe(true);
      expect(result.gotStory).toBe('converged over real WebRTC');
    }
  });

  // WS-S.4.3 §15.4 — a REAL ICE-restart over a real Chromium connection.  A wrapping factory
  // lets the test synthesize the `disconnected` STATE SIGNAL that drives the carrier's
  // watcher; everything downstream is real — the carrier calls the real `pc.restartIce()`,
  // emits a real `iceRestart` re-offer over the live sealed signaling, the real answerer
  // renegotiates, and a frame still flows afterwards (the data channel + §15.5 session key
  // were preserved — no re-handshake).  The deterministic restart STATE MACHINE (grace,
  // bounded retries, offerer-initiates, re-dial fallback) is covered by the unit suite.
  test('performs a real ICE-restart re-offer and keeps the channel alive', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'real WebRTC verified on Chromium');
    await page.goto('/');

    const result = await page.evaluate(async () => {
      try {
        if (typeof RTCPeerConnection !== 'function') return { error: 'no-rtcpeerconnection' };
        const harness = await import('/src/private-p2p/e2e-carrier-harness.ts');
        const { connectPrivatePeer } = harness;
        const p2p = await harness.loadP2p();

        const created = await p2p.createPrivateRoom({
          roomId: 'rt-ice',
          founderMemberId: 'mem-a',
          founderDeviceId: 'dev-a',
          profile: { name: 'Ice', room_type: 'global_topic' },
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
          signalPoll: (peerBlindId: string) => {
            const mine = signals.filter((s) => (s as Rec).recipient_blind_id === peerBlindId);
            for (const s of mine) {
              const i = signals.indexOf(s);
              if (i >= 0) signals.splice(i, 1);
            }
            return Promise.resolve(mine);
          },
        };

        // A wrapping RTCPeerConnection factory: delegates everything to a REAL pc, but lets the
        // test override `connectionState` to inject the `disconnected` signal the watcher reacts
        // to, and counts the real `restartIce()` + `iceRestart` re-offers the carrier issues.
        interface Wrapper {
          _isOfferer: boolean;
          _restartIceCalls: number;
          _iceRestartOffers: number;
          _forceDisconnect(): void;
          _clearOverride(): void;
          connectionState: string;
        }
        const wrappers: Wrapper[] = [];
        const rtcFactory = (config: { iceServers?: unknown; iceTransportPolicy?: string }) => {
          const real = new RTCPeerConnection(config as RTCConfiguration);
          let override: string | undefined;
          let stateHandler: (() => void) | null = null;
          const w = {
            _isOfferer: false,
            _restartIceCalls: 0,
            _iceRestartOffers: 0,
            createDataChannel: (l: string) => {
              w._isOfferer = true;
              return real.createDataChannel(l);
            },
            createOffer: (o?: { iceRestart?: boolean }) => {
              if (o?.iceRestart) w._iceRestartOffers += 1;
              return real.createOffer(o as RTCOfferOptions);
            },
            createAnswer: () => real.createAnswer(),
            setLocalDescription: (d: unknown) =>
              real.setLocalDescription(d as RTCLocalSessionDescriptionInit),
            setRemoteDescription: (d: unknown) =>
              real.setRemoteDescription(d as RTCSessionDescriptionInit),
            addIceCandidate: (c: unknown) => real.addIceCandidate(c as RTCIceCandidateInit),
            restartIce: () => {
              w._restartIceCalls += 1;
              real.restartIce();
            },
            get connectionState() {
              return override ?? real.connectionState;
            },
            get iceConnectionState() {
              return real.iceConnectionState;
            },
            get onicecandidate() {
              return real.onicecandidate as unknown;
            },
            set onicecandidate(fn: unknown) {
              const f = fn as ((e: { candidate: unknown }) => void) | null;
              real.onicecandidate = f ? (e) => f({ candidate: e.candidate }) : null;
            },
            get ondatachannel() {
              return real.ondatachannel as unknown;
            },
            set ondatachannel(fn: unknown) {
              const f = fn as ((e: { channel: unknown }) => void) | null;
              real.ondatachannel = f ? (e) => f({ channel: e.channel }) : null;
            },
            get onconnectionstatechange() {
              return stateHandler as unknown;
            },
            set onconnectionstatechange(fn: unknown) {
              stateHandler = fn as (() => void) | null;
              real.onconnectionstatechange = stateHandler;
            },
            get oniceconnectionstatechange() {
              return real.oniceconnectionstatechange as unknown;
            },
            set oniceconnectionstatechange(fn: unknown) {
              real.oniceconnectionstatechange = fn as (() => void) | null;
            },
            close: () => real.close(),
            _forceDisconnect: () => {
              override = 'disconnected';
              stateHandler?.();
            },
            _clearOverride: () => {
              override = undefined;
              stateHandler?.();
            },
          };
          wrappers.push(w as unknown as Wrapper);
          return w;
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
          iceRestartGraceMs: 50,
          rtcFactory: rtcFactory as never,
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

        const offerer = wrappers.find((w) => w._isOfferer);
        if (!offerer) return { error: 'no-offerer' };

        // Inject the transient failure on the offerer; the watcher waits out the grace, then
        // performs a REAL restartIce() + iceRestart re-offer the real answerer renegotiates.
        offerer._forceDisconnect();
        let restarted = false;
        for (let i = 0; i < 400; i++) {
          if (offerer._restartIceCalls > 0 && offerer._iceRestartOffers > 0) {
            restarted = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        offerer._clearOverride();

        // The data channel survived (a re-handshake would have minted a new session key and the
        // frame would not open): a frame sent AFTER the restart still round-trips.
        const got = new Promise<number[]>((resolve) => {
          b.channel.onMessage((f) => resolve(Array.from(f)));
        });
        await Promise.resolve(a.channel.send(new Uint8Array([42, 43, 44])));
        const received = await Promise.race([
          got,
          new Promise<number[] | 'timeout'>((r) => setTimeout(() => r('timeout'), 5_000)),
        ]);
        a.channel.close();
        b.channel.close();
        return {
          restarted,
          restartIceCalls: offerer._restartIceCalls,
          iceRestartOffers: offerer._iceRestartOffers,
          received,
        };
      } catch (e) {
        return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      }
    });

    expect('error' in result ? result.error : null).toBeNull();
    if (!('error' in result)) {
      expect(result.restarted).toBe(true);
      expect(result.restartIceCalls).toBeGreaterThan(0);
      expect(result.iceRestartOffers).toBeGreaterThan(0);
      expect(result.received).toEqual([42, 43, 44]);
    }
  });
});
