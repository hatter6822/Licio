// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6 — the LIVE MULTI-PEER MESH E2E under real loss: THREE independent browser contexts
// (isolated IndexedDB ⇒ three genuinely-distinct devices) form a private-room mesh over the
// REAL server-blind rendezvous (`POST /v1/private-rendezvous/*`) + real Chromium
// `RTCPeerConnection`s, and converge to the BYTE-IDENTICAL UNION of everything all three
// authored — the core mesh guarantee a single 1:1 link cannot give (it only converges what the
// one partner holds).  Then a peer is DROPPED (its context closed — a hard, un-graceful loss);
// the survivors stay converged and keep working (they author + converge NEW content between
// them), proving the mesh survives a peer loss.
//
// Membership + epoch ordering is realistic: each MLS Add rotates the epoch and the rotating
// commit is delivered only to CURRENTLY-CONNECTED members (§10.9), so C is admitted AFTER A+B
// are already meshed — B advances to C's epoch over the live mesh and can open C's content.
// The `PrivateRoomSession.connectMesh` controller (fill-to-maxPeers, remove-on-drop, re-poll)
// is the real mesh driver; the invite / join-request / grant blobs travel out-of-band (the
// test moves them between contexts through Node, exactly as a real OOB channel would).
//
// Runs under playwright.realwebrtc.config.ts (the Vite DEV server serving /src + proxying /v1 →
// the in-memory API); Chromium only.  The three contexts live in ONE browser process, so their
// ICE candidates resolve on loopback (mDNS obfuscation disabled in the config).

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

// Loose shapes for the REAL manager API (the `/src` dynamic import is unresolvable to tsc, so the
// evaluate callbacks are transpiled, not type-checked; these keep the spec readable without `any`).
interface MeshController {
  peers(): string[];
  close(): void;
}
interface RoomApi {
  readonly deviceId: string;
  createInvite(p: { inviteePublicKey: string }): Promise<{ inviteUrl: string }>;
  admitJoinRequest(
    invite: unknown,
    request: unknown,
  ): Promise<{ verdict: { ok: boolean; reason?: string }; grant?: unknown }>;
  connectMesh(o: {
    transportMode?: 'relay_only' | 'direct_allowed';
    iceServers?: readonly { urls: string }[];
    dialTimeoutMs?: number;
    rePollIntervalMs?: number;
    maxPeers?: number;
    onError?: (e: unknown) => void;
    onMeshChange?: (peers: readonly string[]) => void;
  }): MeshController;
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
// The per-page handle stashed on globalThis (one member per context).
interface Handle {
  h: HarnessApi;
  s?: RoomApi;
  prep?: PrepApi;
  invite?: unknown;
  mesh?: MeshController;
}

const HARNESS = '/src/private-p2p/e2e-room-harness.ts';
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }] as const;
const MESH_OPTS = {
  transportMode: 'direct_allowed' as const,
  iceServers: ICE as unknown as { urls: string }[],
  dialTimeoutMs: 20_000,
  rePollIntervalMs: 1_500,
  maxPeers: 4,
};

test.describe('private room MESH over the real rendezvous (three browsers, WS-S launch gate)', () => {
  // This file RUNS in CI; before the change that added it, `test:e2e:webrtc`
  // appeared in no workflow, so all five real-WebRTC specs were dead letters.
  //
  // It was quarantined at ~1 pass in 3.  The MECHANISM, traced with per-member
  // instrumentation: the §15.4 signal queue was keyed on the RECIPIENT's
  // ephemeral alone, and the drain is DELIVER-ONCE.  In a 3-peer mesh everyone
  // dials everyone at once and each addresses the SAME (freshest) announcement
  // of the member it is dialling — so two offers land in ONE queue, the session
  // that drains it can open only the one matching its channel key, and the other
  // is dropped as un-openable AND already cleared from the box.  Not delayed:
  // destroyed.  That peer then burns its dial deadline against a view that has
  // moved on — the `skipped a signal` warnings, on the member everyone is
  // dialling.  (The previous docstring on `deriveSignalAddress` CLAIMED this
  // could not happen, "gives every pairwise channel its own queue"; that holds
  // only while each session has its own recipient ephemeral, which stops being
  // true the moment two peers pick the same announcement.)
  //
  // FIXED by `deriveSignalAddress` becoming PAIRWISE and DIRECTED — keyed on the
  // sender's identity as well as the recipient's — so the two offers land in
  // different queues and neither is destroyed.  `deriveSignalingKeyPair` (one
  // signalling identity per device per bucket) lands with it: it fixes the
  // separate announcement fan-out, and the pairwise address is what makes it
  // safe.  Which half carries the flake is MEASURED, not assumed — the address
  // change alone, with the old per-call ephemeral still in place, passes.
  //
  // MEASURED (2026-07-29), and the load condition is part of the result:
  //   idle machine     pre-fix 5/5 pass,  fixed 10/10  ← does NOT reproduce idle
  //   under load       pre-fix 0/2 pass,  fixed 13/14
  // "Under load" = three Chromium instances against a looping api+web vitest run,
  // load average 15-17.  That is well beyond CI, which runs this suite alone with
  // one worker.  The single failure did not recur in a second six-run pass and its
  // output was not captured, so its cause is unestablished rather than explained.
  //
  // Because a pass rate depends on the machine, the load-independent evidence is
  // the deterministic pair in `packages/private-p2p/src/__tests__/rendezvous.test.ts`
  // ("a SHARED signal queue destroys a third party's offer"), which exhibits the
  // destruction and its absence with no timing in it at all.
  //
  // An earlier mitigation (dial the freshest candidate and RE-POLL rather than
  // grinding a stale list — PRIV-CARRIER-FRESH-VIEW) took this from 1-in-3 to
  // 6-in-8.  It is kept: still the right dial strategy, and it lowers the cost of
  // a miss.  It did not remove the mechanism, which is why it was a mitigation.
  //
  // Rejected, with the property each would cost: keying the SERVER slot by
  // `peer_blind_id` restores one-slot-per-device but hands any current-epoch
  // member a targeted EVICTION vector — the sharper cousin of the DoS
  // `selectFreshestCandidates` refuses to enable (PRIV-CARRIER-FRESHEST-NOSPOOF);
  // a CI retry count would hide the defect rather than fix it.
  test('3 members converge to the byte-identical union, and the mesh survives a peer drop', async ({
    browser,
    browserName,
  }: {
    browser: Browser;
    browserName: string;
  }) => {
    test.skip(browserName !== 'chromium', 'real WebRTC verified on Chromium');
    test.setTimeout(300_000);

    const contexts: BrowserContext[] = [];
    const newMember = async (): Promise<Page> => {
      const ctx = await browser.newContext();
      contexts.push(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`[pageerror M${contexts.length}] ${e.message}`));
      await page.goto('/');
      return page;
    };

    // --- Node-side helpers that wrap the interleaved page.evaluate round-trips ---------------
    const importHarness = async (page: Page): Promise<void> => {
      await page.evaluate(async (harnessPath) => {
        const h = (await import(harnessPath)) as unknown as HarnessApi;
        (globalThis as unknown as { __M: Handle }).__M = { h };
      }, HARNESS);
    };
    const createRoom = async (page: Page): Promise<string> => {
      return page.evaluate(async () => {
        const m = (globalThis as unknown as { __M: Handle }).__M;
        m.s = await m.h.PrivateRoomSession.create({
          roomName: 'Mesh Room',
          roomType: 'global_topic',
          founderMemberId: 'mem-a',
          founderDeviceId: 'dev-a',
        });
        return m.s.deviceId;
      });
    };
    // Admit `joiner` into the room `founder` owns (the full §10.3 invite → §12.3 join → §14.5
    // grant dance across the two contexts); returns the joiner's handshake device id.
    const joinMember = async (
      founder: Page,
      joiner: Page,
      displayName: string,
    ): Promise<string> => {
      const inviteePublicKey = await joiner.evaluate(async (name) => {
        const m = (globalThis as unknown as { __M: Handle }).__M;
        m.prep = await m.h.PrivateRoomSession.prepareJoinRequest({ proposedDisplayName: name });
        return m.prep.inviteePublicKey;
      }, displayName);

      const sealedInvite = await founder.evaluate(async (key) => {
        const m = (globalThis as unknown as { __M: Handle }).__M;
        if (!m.s) throw new Error('founder session missing');
        const { invite, inviteUrl } = (await m.s.createInvite({ inviteePublicKey: key })) as {
          invite: unknown;
          inviteUrl: string;
        };
        m.invite = invite;
        return inviteUrl.split('#invite=')[1] ?? '';
      }, inviteePublicKey);

      const requestJson = await joiner.evaluate(async (sealed) => {
        const m = (globalThis as unknown as { __M: Handle }).__M;
        if (!m.prep) throw new Error('join preparation missing');
        const { request } = (await m.prep.complete(sealed)) as { request: unknown };
        return JSON.stringify(request);
      }, sealedInvite);

      const admit = await founder.evaluate(async (reqJson) => {
        const m = (globalThis as unknown as { __M: Handle }).__M;
        const request = await m.h.PrivateRoomSession.parseJoinRequest(reqJson);
        if (!request) return { error: 'parse-request-failed' };
        if (!m.s) return { error: 'founder-session-missing' };
        const { verdict, grant } = (await m.s.admitJoinRequest(m.invite, request)) as {
          verdict: { ok: boolean; reason?: string };
          grant?: unknown;
        };
        if (!verdict.ok || !grant) return { error: `admit:${verdict.reason ?? 'unknown'}` };
        return { grantJson: m.h.serializeJoinGrant(grant) };
      }, requestJson);
      expect('error' in admit ? admit.error : null).toBeNull();

      const joined = await joiner.evaluate(
        async (gJson) => {
          const m = (globalThis as unknown as { __M: Handle }).__M;
          const grant = m.h.parseJoinGrant(gJson);
          if (!grant) return { error: 'parse-grant-failed' };
          m.s = await m.prep?.completeJoin(grant);
          return { deviceId: m.s?.deviceId ?? '' };
        },
        'grantJson' in admit ? admit.grantJson : '',
      );
      expect('error' in joined ? joined.error : null).toBeNull();
      return 'deviceId' in joined ? joined.deviceId : '';
    };

    const startMesh = async (page: Page): Promise<void> => {
      await page.evaluate(async (opts) => {
        const m = (globalThis as unknown as { __M: Handle }).__M;
        m.mesh = m.s?.connectMesh(opts);
      }, MESH_OPTS);
    };
    const meshPeers = (page: Page): Promise<string[]> =>
      page.evaluate(() => (globalThis as unknown as { __M: Handle }).__M.mesh?.peers() ?? []);
    const authorStory = async (page: Page, title: string): Promise<void> => {
      await page.evaluate(async (t) => {
        await (globalThis as unknown as { __M: Handle }).__M.s?.postStory({ title: t });
      }, title);
    };
    const snapshot = (page: Page): Promise<{ titles: string[]; commit: number[] }> =>
      page.evaluate(async () => {
        const m = (globalThis as unknown as { __M: Handle }).__M;
        const titles = [...(m.s?.state().stories.values() ?? [])].map((x) => x.title);
        const p2p = await m.h.loadP2p();
        const commit = m.s ? Array.from(p2p.roomStateCommitment(m.s.state())) : [];
        return { titles, commit };
      });
    const waitFor = async (
      label: string,
      cond: () => Promise<boolean>,
      ms = 90_000,
    ): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error(`waitFor timed out: ${label}`);
    };
    const eq = (a: number[], b: number[]): boolean =>
      a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

    try {
      // Create SEQUENTIALLY so `contexts[0..2]` deterministically map to A/B/C (a concurrent
      // Promise.all would push them in a nondeterministic order, so "close C" could close the wrong one).
      const pageA = await newMember();
      const pageB = await newMember();
      const pageC = await newMember();
      expect(await pageA.evaluate(() => typeof RTCPeerConnection === 'function')).toBe(true);
      await Promise.all([importHarness(pageA), importHarness(pageB), importHarness(pageC)]);

      // 1) A founds the room; B joins (epoch e1).
      const devA = await createRoom(pageA);
      const devB = await joinMember(pageA, pageB, 'Bob');
      expect(devB).toBeTruthy();

      // 2) A + B mesh FIRST (both at e1) — so B is LIVE when C is admitted and receives the
      //    epoch-rotating commit over the mesh (otherwise B could not open C's new-epoch content).
      await startMesh(pageA);
      await startMesh(pageB);
      await waitFor(
        'A↔B mesh',
        async () =>
          (await meshPeers(pageA)).includes(devB) && (await meshPeers(pageB)).includes(devA),
      );

      // 3) C joins (epoch e2) WHILE A+B are meshed — A broadcasts the rotating commit to B live.
      const devC = await joinMember(pageA, pageC, 'Carol');
      expect(devC).toBeTruthy();

      // 4) C meshes; the full three-peer mesh forms (A sees B+C).
      await startMesh(pageC);
      await waitFor(
        'C in A/B mesh',
        async () => {
          const pa = await meshPeers(pageA);
          return pa.includes(devB) && pa.includes(devC);
        },
        120_000,
      );

      // 5) Each of the three authors a DISTINCT story over the live mesh.
      await authorStory(pageA, 'story-alice');
      await authorStory(pageB, 'story-bob');
      await authorStory(pageC, 'story-carol');

      // 6) All THREE converge to the byte-identical UNION (all three stories + identical commitment)
      //    — the core mesh guarantee (each holds what ALL members authored, not just its partner's).
      const allThree = ['story-alice', 'story-bob', 'story-carol'];
      await waitFor(
        'three-peer union convergence',
        async () => {
          const [a, b, c] = await Promise.all([snapshot(pageA), snapshot(pageB), snapshot(pageC)]);
          const has = (t: string[]) => allThree.every((s) => t.includes(s));
          return (
            has(a.titles) &&
            has(b.titles) &&
            has(c.titles) &&
            eq(a.commit, b.commit) &&
            eq(b.commit, c.commit)
          );
        },
        120_000,
      );

      // 7) REAL LOSS: drop C (close its context — a hard, un-graceful disconnect).
      const ctxC = contexts[2];
      await ctxC?.close();

      // 8) The survivors stay converged AND keep working: A authors a NEW story; B converges on it
      //    over the surviving A↔B mesh (C, gone, does not — as expected).
      await authorStory(pageA, 'after-drop');
      await waitFor(
        'A↔B survive the drop + converge new content',
        async () => {
          const [a, b] = await Promise.all([snapshot(pageA), snapshot(pageB)]);
          return (
            a.titles.includes('after-drop') &&
            b.titles.includes('after-drop') &&
            eq(a.commit, b.commit)
          );
        },
        90_000,
      );
    } finally {
      for (const ctx of contexts) {
        await ctx.close().catch(() => {});
      }
    }
  });
});
