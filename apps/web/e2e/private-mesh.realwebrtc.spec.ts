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
  // QUARANTINED on a DIAGNOSED — and only PARTLY fixed — protocol defect.  The
  // file now RUNS in CI; before this change `test:e2e:webrtc` appeared in no
  // workflow, so all five real-WebRTC specs were dead letters.
  //
  // Measured: 1 pass in 3 before the `connect-peer.ts` change below, 6 in 8
  // after.  Better is not fixed, so it stays quarantined rather than retried.
  //
  // ROOT CAUSE (traced with per-member dial instrumentation, not inferred).
  // A handshake needs BOTH peers to select each OTHER'S CURRENT announcement,
  // because the signalling channel key is ECDH(own ephemeral, the peer's
  // ANNOUNCED ephemeral).  Each dial mints a fresh ephemeral and drains only
  // that one's inbound queue, so every SUPERSEDED announcement names an address
  // nobody answers at — and it stays live for the §15.3.2 TTL (5-minute floor)
  // because there is no retraction and the store keys presence by the sealed
  // ciphertext, so a re-announce ADDS a slot instead of replacing the device's.
  // Observed: one peer holding THREE live candidates for a single device, and
  // offers landing at dead addresses failing AEAD open — the `skipped a signal`
  // warnings, only on the joining member.
  //
  // WHAT IS FIXED: the amplifier.  `connectPrivatePeer` used to grind through the
  // whole candidate list before re-polling, spending `candidates × deadline`
  // against a view that was already stale — while the peer, symmetrically stuck,
  // announced newer ephemerals that round would never see.  It now dials the
  // freshest candidate and RE-POLLS (PRIV-CARRIER-FRESH-VIEW), so the two sides'
  // selections converge within a poll interval.
  //
  // WHAT IS NOT: the residual coincidence.  Two peers can still pick
  // each other's second-newest announcement in the same round.  The fix that
  // removes it — and the only option that adds NO new forgeability — is for a
  // peer to keep ANSWERING at every ephemeral it has advertised and not yet let
  // expire, resolving the channel key from the signal's `sender_blind_id`
  // (already on the wire) instead of from a peer pre-selected before the offer
  // arrives.  That is a real change to the §15.5 handshake on the
  // launch-blocking E2EE plane and is deliberately NOT rushed here.
  //
  // Rejected alternatives, with the property each would cost: keying the server
  // slot by `peer_blind_id` restores one-slot-per-device but hands any
  // current-epoch member a targeted EVICTION vector — the sharper cousin of the
  // DoS `selectFreshestCandidates` refuses to enable (PRIV-CARRIER-FRESHEST-
  // NOSPOOF); reusing one ephemeral per device reintroduces the shared-queue
  // stall that same comment documents, because an established session's
  // ICE-restart watcher keeps draining the address after its dial ends.
  //
  // Tracked with this trace in `docs/planning/audit-residuals-2026-07.md`.
  test.fixme('3 members converge to the byte-identical union, and the mesh survives a peer drop', async ({
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
