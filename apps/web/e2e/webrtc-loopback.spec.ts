// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6a / WS-S.4.3 — REAL browser WebRTC loopback (the "network testing" leg).
// `connectWebrtc`'s orchestration (offer/answer/ICE-buffering/datachannel-open/teardown)
// is unit-proven against a faithful fake RTCPeerConnection pair; this complements it by
// proving the OTHER half: that a REAL browser `RTCPeerConnection` establishes an
// `RTCDataChannel` and carries an exchange-shaped byte payload end-to-end on THIS machine
// — i.e. the WebRTC carrier the live private-p2p + LCAP P2P transports ride is exercisable
// against real WebRTC, not only a mock.  Two real peers connect via an in-page signaling
// relay + host ICE candidates (localhost), so it is deterministic in headless Chromium.

import { expect, test } from '@playwright/test';

test.describe('real WebRTC datachannel loopback (WS-R.15.6a network testing)', () => {
  test('two real RTCPeerConnections establish a datachannel and exchange bytes', async ({
    page,
    browserName,
  }) => {
    // Headless WebRTC loopback is reliable on Chromium; Firefox/WebKit headless WebRTC is
    // flaky in CI, so this environment-capability check runs on Chromium.
    test.skip(browserName !== 'chromium', 'WebRTC loopback verified on Chromium');
    await page.goto('/');

    const result = await page.evaluate(async () => {
      // Guard: localhost is a secure context, so RTCPeerConnection must exist.
      if (typeof RTCPeerConnection !== 'function') return { error: 'no-rtcpeerconnection' };

      const config: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
      const a = new RTCPeerConnection(config);
      const b = new RTCPeerConnection(config);

      // In-page signaling relay (the server-blind rendezvous is tested separately; here we
      // exercise the REAL offer/answer/ICE/datachannel mechanics).
      a.onicecandidate = (e) => {
        if (e.candidate) void b.addIceCandidate(e.candidate);
      };
      b.onicecandidate = (e) => {
        if (e.candidate) void a.addIceCandidate(e.candidate);
      };

      const dcA = a.createDataChannel('lcap');
      const opened = new Promise<RTCDataChannel>((resolve) => {
        b.ondatachannel = (e) => resolve(e.channel);
      });

      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      await b.setRemoteDescription(offer);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);

      const dcB = await opened;

      // Wait for BOTH channels to open.
      const waitOpen = (dc: RTCDataChannel) =>
        new Promise<void>((resolve) => {
          if (dc.readyState === 'open') return resolve();
          dc.onopen = () => resolve();
        });
      await Promise.all([waitOpen(dcA), waitOpen(dcB)]);
      dcA.binaryType = 'arraybuffer';
      dcB.binaryType = 'arraybuffer';

      // Exchange an exchange-shaped byte payload end-to-end over the REAL datachannel.
      const payload = new Uint8Array([16, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255, 0, 128]);
      const received = new Promise<number[]>((resolve) => {
        dcB.onmessage = (ev) => resolve(Array.from(new Uint8Array(ev.data as ArrayBuffer)));
      });
      dcA.send(payload);
      const got = await received;

      const connected = a.iceConnectionState;
      a.close();
      b.close();
      return { got, sent: Array.from(payload), connected };
    });

    expect('error' in result ? result.error : null).toBeNull();
    if (!('error' in result)) {
      expect(result.got).toEqual(result.sent); // exact bytes over a real datachannel
      expect(['connected', 'completed']).toContain(result.connected);
    }
  });
});
