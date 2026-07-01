// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 / WS-S.6.6 — the LIVE two-browser private-room E2E: the full
// create → invite → join → connect → converge dance across TWO independent browser
// contexts (isolated IndexedDB ⇒ two genuinely-distinct devices), signalling ONLY over
// the REAL server-blind rendezvous endpoint (`POST /v1/private-rendezvous/*`, dev-proxied
// to the in-memory API) and a REAL Chromium `RTCPeerConnection`.
//
// This closes the last WS-S launch-blocking residual (`docs/private-p2p/README.md`): the
// prior real-WebRTC spec ran both peers in ONE page with an in-page rendezvous bridge and
// SHARED epoch keys.  This one uses the ACTUAL `PrivateRoomSession` manager end-to-end —
// founder A mints an HPKE-sealed §10.3 invite, joiner B (a separate context) opens it and
// builds a §12.3 join request, A admits it (MLS Add → §14.5 grant), B `completeJoin`s, then
// BOTH `connect()` over the live rendezvous, discover each other, complete the §15.5
// membership handshake over real WebRTC, and converge to BYTE-IDENTICAL reduced state.  The
// invite / join-request / grant blobs travel out-of-band (member→member); the test moves
// them between the two contexts through Node, exactly as a real OOB channel would.
//
// Runs under playwright.realwebrtc.config.ts (the Vite DEV server, which serves /src as ES
// modules AND proxies /v1 → the in-memory API); Chromium only (headless WebRTC is reliable
// there).  The two contexts live in ONE browser process, so their ICE candidates resolve.

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

/** Loose shapes for the REAL harness/manager APIs (the `/src` dynamic import is unresolvable
 *  to tsc, so the callbacks are transpiled, not type-checked; these keep the spec readable
 *  without the `any` keyword — the casts are erased at runtime). */
interface RoomApi {
  readonly memberId: string;
  readonly deviceId: string;
  createInvite(p: { inviteePublicKey: string }): Promise<{ inviteUrl: string }>;
  admitJoinRequest(
    invite: unknown,
    request: unknown,
  ): Promise<{ verdict: { ok: boolean; reason?: string }; grant?: unknown }>;
  connect(o: {
    transportMode?: 'relay_only' | 'direct_allowed';
    iceServers?: readonly { urls: string }[];
    timeoutMs?: number;
  }): Promise<unknown>;
  postStory(i: { title: string }): Promise<string>;
  state(): { stories: Map<string, { title: string }> };
}
interface PrepApi {
  readonly inviteePublicKey: string;
  complete(sealed: string): Promise<{ invite: unknown; request: unknown }>;
  completeJoin(grant: unknown): Promise<RoomApi>;
}
interface HarnessApi {
  readonly PrivateRoomSession: {
    create(p: {
      roomName: string;
      roomType: string;
      founderMemberId: string;
      founderDeviceId: string;
    }): Promise<RoomApi>;
    prepareJoinRequest(p: { proposedDisplayName: string }): Promise<PrepApi>;
    parseJoinRequest(json: string): Promise<unknown>;
  };
  serializeJoinGrant(grant: unknown): string;
  parseJoinGrant(json: string): unknown;
  loadP2p(): Promise<{ roomStateCommitment(state: unknown): Uint8Array }>;
}

const HARNESS = '/src/private-p2p/e2e-room-harness.ts';
// A local STUN helps gather srflx candidates, but two contexts in one browser process
// connect via host candidates alone (so the test does not depend on internet).
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }] as const;

test.describe('private room over the real rendezvous (two browsers, WS-S launch gate)', () => {
  test('create → invite → join → connect → converge byte-identically over /v1/private-rendezvous', async ({
    browser,
    browserName,
  }: {
    browser: Browser;
    browserName: string;
  }) => {
    test.skip(browserName !== 'chromium', 'real WebRTC verified on Chromium');
    test.setTimeout(180_000);

    let ctxA: BrowserContext | undefined;
    let ctxB: BrowserContext | undefined;
    try {
      ctxA = await browser.newContext();
      ctxB = await browser.newContext();
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      // Surface in-page console errors to the test log (WebRTC/crypto failures otherwise hide).
      for (const [tag, pg] of [
        ['A', pageA],
        ['B', pageB],
      ] as const) {
        pg.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`));
      }
      await pageA.goto('/');
      await pageB.goto('/');
      expect(await pageA.evaluate(() => typeof RTCPeerConnection === 'function')).toBe(true);

      // 1) A founds the private room (stash the live session on the page globalThis so it
      //    survives across the interleaved evaluate calls).
      const created = await pageA.evaluate(async (harnessPath) => {
        const h = (await import(harnessPath)) as unknown as HarnessApi;
        const s = await h.PrivateRoomSession.create({
          roomName: 'Two-Browser Room',
          roomType: 'global_topic',
          founderMemberId: 'mem-a',
          founderDeviceId: 'dev-a',
        });
        (globalThis as unknown as { __A: { h: HarnessApi; s: RoomApi; invite?: unknown } }).__A = {
          h,
          s,
        };
        return { memberId: s.memberId, deviceId: s.deviceId };
      }, HARNESS);
      expect(created.deviceId).toBeTruthy();

      // 2) B (a separate context) prepares its §12.3 join — a fresh HPKE key + MLS KeyPackage
      //    — and returns the invitee public key A seals the invite to.
      const inviteePublicKey = await pageB.evaluate(async (harnessPath) => {
        const h = (await import(harnessPath)) as unknown as HarnessApi;
        const prep = await h.PrivateRoomSession.prepareJoinRequest({ proposedDisplayName: 'Bob' });
        (globalThis as unknown as { __B: { h: HarnessApi; prep: PrepApi; s?: RoomApi } }).__B = {
          h,
          prep,
        };
        return prep.inviteePublicKey;
      }, HARNESS);
      expect(inviteePublicKey.length).toBeGreaterThan(0);

      // 3) A mints an HPKE-sealed invite for B and hands back the sealed fragment (the secret
      //    lives only in the URL fragment — it never rides an HTTP request to a server).
      const sealedInvite = await pageA.evaluate(async (inviteeKey) => {
        const A = (globalThis as unknown as { __A: { s: RoomApi; invite?: unknown } }).__A;
        const { invite, inviteUrl } = (await A.s.createInvite({
          inviteePublicKey: inviteeKey,
        })) as {
          invite: unknown;
          inviteUrl: string;
        };
        A.invite = invite; // A keeps the InviteSecret to verify the resulting join request
        return inviteUrl.split('#invite=')[1] ?? '';
      }, inviteePublicKey);
      expect(sealedInvite.length).toBeGreaterThan(0);

      // 4) B opens the invite (HPKE) and builds the §12.3 join request.
      const requestJson = await pageB.evaluate(async (sealed) => {
        const B = (globalThis as unknown as { __B: { prep: PrepApi; invite?: unknown } }).__B;
        const { invite, request } = await B.prep.complete(sealed);
        B.invite = invite;
        return JSON.stringify(request);
      }, sealedInvite);

      // 5) A verifies the join request against the invite it minted and ADMITS the device
      //    (the MLS Add → new epoch → the §14.5 grant B bootstraps from).
      const admit = await pageA.evaluate(async (reqJson) => {
        const A = (
          globalThis as unknown as { __A: { h: HarnessApi; s: RoomApi; invite?: unknown } }
        ).__A;
        const request = await A.h.PrivateRoomSession.parseJoinRequest(reqJson);
        if (!request) return { error: 'parse-join-request-failed' };
        const { verdict, grant } = await A.s.admitJoinRequest(A.invite, request);
        if (!verdict.ok || !grant) return { error: `admit-failed:${verdict.reason ?? 'unknown'}` };
        return { grantJson: A.h.serializeJoinGrant(grant) };
      }, requestJson);
      expect('error' in admit ? admit.error : null).toBeNull();
      const grantJson = 'grantJson' in admit ? admit.grantJson : '';

      // 6) B completes the join (MLS Welcome → a usable member session, bootstrapped from the
      //    grant's re-validated §14.5 snapshot — no historical epoch keys).
      const joined = await pageB.evaluate(async (gJson) => {
        const B = (globalThis as unknown as { __B: { h: HarnessApi; prep: PrepApi; s?: RoomApi } })
          .__B;
        const grant = B.h.parseJoinGrant(gJson);
        if (!grant) return { error: 'parse-grant-failed' };
        B.s = await B.prep.completeJoin(grant);
        return { memberId: B.s.memberId, deviceId: B.s.deviceId };
      }, grantJson);
      expect('error' in joined ? joined.error : null).toBeNull();

      // 7) BOTH connect over the LIVE rendezvous + real WebRTC.  Kick each off WITHOUT awaiting
      //    (each connect blocks until it discovers the other, so awaiting A here would deadlock
      //    before B announces); stash the promise, then await both.
      const kickConnect = async (pg: Page, key: '__A' | '__B') => {
        return pg.evaluate(
          async ({ k, ice }) => {
            const store = globalThis as unknown as Record<
              string,
              { s?: RoomApi; connectP?: Promise<unknown> }
            >;
            const handle = store[k];
            if (!handle?.s) return { error: 'no-session' };
            // `direct_allowed` so the two localhost contexts connect via host candidates (no TURN);
            // relay-only (the IP-privacy default) would require a TURN server this offline test lacks.
            handle.connectP = handle.s.connect({
              transportMode: 'direct_allowed',
              iceServers: ice,
              timeoutMs: 40_000,
            });
            handle.connectP.catch(() => {}); // avoid an unhandled rejection before we await it
            return { ok: true };
          },
          { k: key, ice: ICE as unknown as { urls: string }[] },
        );
      };
      expect((await kickConnect(pageA, '__A')) as { ok?: boolean }).toEqual({ ok: true });
      expect((await kickConnect(pageB, '__B')) as { ok?: boolean }).toEqual({ ok: true });

      const awaitConnect = async (pg: Page, key: '__A' | '__B') => {
        return pg.evaluate(async (k) => {
          const handle = (globalThis as unknown as Record<string, { connectP?: Promise<unknown> }>)[
            k
          ];
          try {
            await handle?.connectP;
            return { ok: true };
          } catch (e) {
            return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
          }
        }, key);
      };
      const [connA, connB] = await Promise.all([
        awaitConnect(pageA, '__A'),
        awaitConnect(pageB, '__B'),
      ]);
      expect('error' in connA ? connA.error : null).toBeNull();
      expect('error' in connB ? connB.error : null).toBeNull();

      // 8) Each authors a story over the LIVE channel (bidirectional content movement).
      await pageA.evaluate(async () => {
        await (globalThis as unknown as { __A: { s: RoomApi } }).__A.s.postStory({
          title: 'from-alice',
        });
      });
      await pageB.evaluate(async () => {
        await (globalThis as unknown as { __B: { s: RoomApi } }).__B.s.postStory({
          title: 'from-bob',
        });
      });

      // 9) Poll BOTH contexts until each holds BOTH stories AND their reduced-state commitments
      //    are byte-identical (the strongest convergence proof — every op, in canonical order).
      const snapshot = async (pg: Page, key: '__A' | '__B') => {
        return pg.evaluate(async (k) => {
          const handle = (globalThis as unknown as Record<string, { h: HarnessApi; s: RoomApi }>)[
            k
          ];
          const titles = [...handle.s.state().stories.values()].map((x) => x.title);
          const p2p = await handle.h.loadP2p();
          const commit = Array.from(p2p.roomStateCommitment(handle.s.state()));
          return { titles, commit };
        }, key);
      };

      let converged = false;
      let last: { a: number[]; b: number[]; aTitles: string[]; bTitles: string[] } | null = null;
      for (let i = 0; i < 200; i++) {
        const [a, b] = await Promise.all([snapshot(pageA, '__A'), snapshot(pageB, '__B')]);
        const bothHave = (t: string[]) => t.includes('from-alice') && t.includes('from-bob');
        const commitEqual =
          a.commit.length === b.commit.length && a.commit.every((x, j) => x === b.commit[j]);
        last = { a: a.commit, b: b.commit, aTitles: a.titles, bTitles: b.titles };
        if (bothHave(a.titles) && bothHave(b.titles) && commitEqual) {
          converged = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      expect(
        converged,
        `did not converge; A titles=${JSON.stringify(last?.aTitles)} B titles=${JSON.stringify(
          last?.bTitles,
        )} commitEqual=${last ? last.a.length === last.b.length : 'n/a'}`,
      ).toBe(true);
    } finally {
      await ctxA?.close();
      await ctxB?.close();
    }
  });
});
