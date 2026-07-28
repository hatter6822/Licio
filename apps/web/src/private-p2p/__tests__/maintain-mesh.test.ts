// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-7 finding 14 — the §15.6 multi-peer mesh: fill up to maxPeers DISTINCT peers (so the
// local engine converges with several online members, not just the first dialed), remove a
// peer on a drop, and re-poll to fill freed slots.  The `dial` is injected, so the mesh
// logic is tested without WebRTC.

import { describe, expect, it } from 'vitest';
import { type DialedSession, type MeshDial, maintainMesh } from '../sync-session.js';

/**
 * Poll until `cond` holds, and THROW when it does not.
 *
 * Returning silently on timeout made every bare `await waitFor(...)` a no-op:
 * the mesh could fail to dial, fail to drop, or never re-mesh after the
 * cooldown, and the test would still pass — the cooldown-expiry case at the
 * end of the churn test had no other assertion at all.  `ice-restart.test.ts`
 * and the real-WebRTC e2e spec already throw here; these two were the
 * asymmetric ones.
 */
const waitFor = async (cond: () => boolean, label = 'condition', ms = 1_000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`waitFor timed out: ${label}`);
};

describe('maintainMesh (§15.6 multi-peer)', () => {
  it('fills to maxPeers distinct peers, removes on drop, refills, and close() leaves all', async () => {
    let online = ['p0', 'p1', 'p2', 'p3', 'p4'];
    const drops = new Map<string, (peerId: string, graceful: boolean) => void>();
    const closed: string[] = [];
    const dial: MeshDial = (connected, onDrop) => {
      const next = online.find((p) => !connected.has(p));
      if (!next) return Promise.resolve(null);
      drops.set(next, onDrop);
      const session: DialedSession = { close: () => closed.push(next) };
      return Promise.resolve({ peerId: next, session });
    };
    const ctrl = maintainMesh(dial, {
      maxPeers: 3,
      rePollIntervalMs: 2,
      sleep: (msv) => new Promise((r) => setTimeout(r, msv)),
    });

    // Fills to maxPeers (the first three of the supply).
    await waitFor(() => ctrl.peers().length === 3);
    expect(ctrl.peers().sort()).toEqual(['p0', 'p1', 'p2']);

    // p1 goes offline + its session drops; the re-poll refills the freed slot with p3.
    online = online.filter((p) => p !== 'p1');
    drops.get('p1')?.('p1', false);
    await waitFor(() => ctrl.peers().includes('p3'));
    expect(ctrl.peers().includes('p1')).toBe(false);
    expect(ctrl.peers().length).toBe(3);

    // close() gracefully closes every peer session + stops the mesh.
    ctrl.close();
    expect(ctrl.peers()).toEqual([]);
    expect(closed).toContain('p0');
  });

  it('never exceeds maxPeers even with an unlimited supply', async () => {
    let n = 0;
    const dial: MeshDial = () => {
      const id = `peer-${n++}`;
      return Promise.resolve({ peerId: id, session: { close: () => {} } });
    };
    const ctrl = maintainMesh(dial, {
      maxPeers: 2,
      rePollIntervalMs: 2,
      sleep: (msv) => new Promise((r) => setTimeout(r, msv)),
    });
    await waitFor(() => ctrl.peers().length === 2);
    // Give the re-poll several cycles — it must NOT keep adding past maxPeers.
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrl.peers().length).toBe(2);
    ctrl.close();
  });

  it('does NOT re-dial a graceful leaver until the cooldown expires (no churn)', async () => {
    let now = 1_000;
    const online = ['p0', 'p1'];
    const drops = new Map<string, (peerId: string, graceful: boolean) => void>();
    const dial: MeshDial = (connected, onDrop) => {
      const next = online.find((p) => !connected.has(p));
      if (!next) return Promise.resolve(null);
      drops.set(next, onDrop);
      return Promise.resolve({ peerId: next, session: { close: () => {} } });
    };
    const ctrl = maintainMesh(dial, {
      maxPeers: 2,
      rePollIntervalMs: 2,
      gracefulCooldownMs: 1_000,
      nowMs: () => now,
      sleep: (msv) => new Promise((r) => setTimeout(r, msv)),
    });
    await waitFor(() => ctrl.peers().length === 2);

    // p1 leaves GRACEFULLY (sent bye) — still "online" (its record lingers), but the mesh
    // must NOT re-dial it during the cooldown (the churn bug).
    drops.get('p1')?.('p1', true);
    await waitFor(() => !ctrl.peers().includes('p1'));
    await new Promise((r) => setTimeout(r, 40)); // many re-poll cycles within the cooldown
    expect(ctrl.peers().includes('p1')).toBe(false);

    // After the cooldown expires, p1 is re-meshable (e.g. it came back online).
    now += 5_000;
    await waitFor(() => ctrl.peers().includes('p1'));
    ctrl.close();
  });
});
