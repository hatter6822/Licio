// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-7 finding 14 — the §15.6 multi-peer mesh: fill up to maxPeers DISTINCT peers (so the
// local engine converges with several online members, not just the first dialed), remove a
// peer on a drop, and re-poll to fill freed slots.  The `dial` is injected, so the mesh
// logic is tested without WebRTC.

import { describe, expect, it } from 'vitest';
import { type DialedSession, type MeshDial, maintainMesh } from '../sync-session.js';

const waitFor = async (cond: () => boolean, ms = 1_000): Promise<void> => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 2));
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
});
