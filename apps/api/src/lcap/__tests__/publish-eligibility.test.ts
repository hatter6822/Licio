// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7 / WS-S.4.4) — the SERVER-SIDE publish-eligibility derivation.  These cover
// the fail-closed matrix of `fromStory` (the per-target rule) + `aggregateEligibility`, including
// the rule that a HIDDEN (takedown/safety) story is NEVER publishable even when its stored
// visibility is still `public` — so review-approved-but-since-hidden content cannot be pinned to
// the public DHT (the takedown oracle catches a takedown; this also catches a safety hide).

import { describe, expect, it } from 'vitest';
import { aggregateEligibility, fromStory } from '../publish-eligibility.js';

describe('Gate-19 — fromStory eligibility matrix', () => {
  it('refuses a story left PUBLIC inside a PRIVATE room', () => {
    // The resolver derived visibility from storage mode, story visibility and hidden
    // state — never from whether the ROOM is private — so a stranded public row in a
    // private server room resolved publishable and could be pinned to the public DHT.
    //
    // Such a row should not exist: migration 0110's trigger refuses one on any write.
    // But a trigger fires only on a write, and 0110's backfill deliberately SKIPS rows
    // whose canonical URL already has a live in-room twin — so the rows it cannot
    // convert are exactly the ones nothing revisits.  Deriving the room's visibility
    // means the publisher cannot leak whichever way that is resolved.
    expect(
      fromStory({
        storageMode: 'server',
        roomVisibility: 'private',
        visibility: 'public',
        hiddenState: null,
      }),
    ).toMatchObject({ publishable: false, visibility: 'in_room', reason: 'private_room' });
    // …and the ordinary in-room story keeps its own reason, so the two are
    // distinguishable in the publish audit.
    expect(
      fromStory({
        storageMode: 'server',
        roomVisibility: 'public',
        visibility: 'room_only',
        hiddenState: null,
      }),
    ).toMatchObject({ publishable: false, reason: 'room_only' });
  });

  it('a LIVE public server story is publishable', () => {
    expect(
      fromStory({
        storageMode: 'server',
        roomVisibility: 'public',
        visibility: 'public',
        hiddenState: null,
      }),
    ).toEqual({
      publishable: true,
      visibility: 'public',
      privateRoomCid: false,
    });
  });

  it('a HIDDEN public server story (takedown OR safety) is NOT publishable', () => {
    for (const hiddenState of ['takedown', 'safety']) {
      const e = fromStory({
        storageMode: 'server',
        roomVisibility: 'public',
        visibility: 'public',
        hiddenState,
      });
      expect(e.publishable).toBe(false);
      expect(e.visibility).toBe('in_room');
      expect(e.reason).toBe('hidden');
    }
  });

  it('a room_only story is NOT publishable (reason room_only)', () => {
    const e = fromStory({
      storageMode: 'server',
      roomVisibility: 'public',
      visibility: 'room_only',
      hiddenState: null,
    });
    expect(e.publishable).toBe(false);
    expect(e.reason).toBe('room_only');
  });

  it('a p2p-room story is NOT publishable (privateRoomCid, reason p2p_room)', () => {
    const e = fromStory({
      storageMode: 'p2p',
      roomVisibility: 'public',
      visibility: 'public',
      hiddenState: null,
    });
    expect(e.publishable).toBe(false);
    expect(e.privateRoomCid).toBe(true);
    expect(e.reason).toBe('p2p_room');
  });

  it('p2p takes precedence over hidden in the reason (most severe first)', () => {
    const e = fromStory({
      storageMode: 'p2p',
      roomVisibility: 'public',
      visibility: 'public',
      hiddenState: 'takedown',
    });
    expect(e.publishable).toBe(false);
    expect(e.reason).toBe('p2p_room');
  });

  it('a missing target is fail-closed not-publishable', () => {
    expect(fromStory(undefined).publishable).toBe(false);
    expect(fromStory(undefined).reason).toBe('target_not_found');
  });
});

describe('Gate-19 — aggregateEligibility', () => {
  it('a single hidden target makes the whole batch not publishable', () => {
    const live = { publishable: true, visibility: 'public' as const, privateRoomCid: false };
    const hidden = {
      publishable: false,
      visibility: 'in_room' as const,
      privateRoomCid: false,
      reason: 'hidden',
    };
    const agg = aggregateEligibility([live, hidden]);
    expect(agg.publishable).toBe(false);
    expect(agg.reason).toBe('hidden');
  });
});
