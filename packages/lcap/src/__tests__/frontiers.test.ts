// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Frontier comparison (§16.2, §17.2, §17.3, WS-R.6.1/R.7.1): a node is "behind"
// on a room checkpoint or a revocation scope when its frontier integers trail
// the counterpart's; an absent entry is fully behind.

import { describe, expect, it } from 'vitest';
import type { CheckpointFrontierV2, RevocationFrontierV2 } from '../schemas/index.js';
import {
  compareRevocationFrontiers,
  diffCheckpointFrontiers,
  isCheckpointBehind,
} from '../sync/index.js';

const roomA = new Uint8Array([0xaa]);
const roomB = new Uint8Array([0xbb]);

const ckpt = (
  room: Uint8Array,
  over: Omit<CheckpointFrontierV2, 'room_id_hash'> = {},
): CheckpointFrontierV2 => ({ room_id_hash: room, ...over });

describe('isCheckpointBehind (§17.2)', () => {
  it('is behind when the local entry is missing', () => {
    expect(isCheckpointBehind(undefined, ckpt(roomA, { latest_tree_size: 5 }))).toBe(true);
  });

  it('is behind by tree size', () => {
    expect(
      isCheckpointBehind(
        ckpt(roomA, { latest_tree_size: 3 }),
        ckpt(roomA, { latest_tree_size: 5 }),
      ),
    ).toBe(true);
  });

  it('is behind by policy epoch', () => {
    expect(
      isCheckpointBehind(
        ckpt(roomA, { latest_tree_size: 5, latest_policy_epoch: 1 }),
        ckpt(roomA, { latest_tree_size: 5, latest_policy_epoch: 2 }),
      ),
    ).toBe(true);
  });

  it('is behind by revocation epoch', () => {
    expect(
      isCheckpointBehind(
        ckpt(roomA, { latest_revocation_epoch: 1 }),
        ckpt(roomA, { latest_revocation_epoch: 2 }),
      ),
    ).toBe(true);
  });

  it('is not behind when equal or ahead', () => {
    expect(
      isCheckpointBehind(
        ckpt(roomA, { latest_tree_size: 5 }),
        ckpt(roomA, { latest_tree_size: 5 }),
      ),
    ).toBe(false);
    expect(
      isCheckpointBehind(
        ckpt(roomA, { latest_tree_size: 7 }),
        ckpt(roomA, { latest_tree_size: 5 }),
      ),
    ).toBe(false);
  });
});

describe('diffCheckpointFrontiers (§17.2)', () => {
  it('returns only the rooms we are behind on, deterministically', () => {
    const local = [ckpt(roomA, { latest_tree_size: 5 }), ckpt(roomB, { latest_tree_size: 2 })];
    const remote = [ckpt(roomA, { latest_tree_size: 5 }), ckpt(roomB, { latest_tree_size: 9 })];
    const behind = diffCheckpointFrontiers(local, remote);
    expect(behind.map((f) => f.room_id_hash[0])).toEqual([0xbb]);
  });

  it('treats a wholly-unknown remote room as behind', () => {
    const behind = diffCheckpointFrontiers([], [ckpt(roomA, { latest_tree_size: 1 })]);
    expect(behind).toHaveLength(1);
  });
});

const rev = (
  scope: RevocationFrontierV2['scope'],
  epoch: number,
  over: Omit<RevocationFrontierV2, 'scope' | 'revocation_epoch'> = {},
): RevocationFrontierV2 => ({ scope, revocation_epoch: epoch, ...over });

describe('compareRevocationFrontiers (§17.3)', () => {
  it('classifies behind / ahead per scope', () => {
    const local = [rev('global', 3), rev('room', 5, { scope_hash: roomA })];
    const remote = [rev('global', 7), rev('room', 2, { scope_hash: roomA })];
    const cmp = compareRevocationFrontiers(local, remote);
    expect(cmp.weAreBehind.map((f) => f.scope)).toEqual(['global']);
    expect(cmp.remoteIsBehind.map((f) => f.scope)).toEqual(['room']);
  });

  it('treats a scope present on only one side as behind for the side that lacks it', () => {
    const cmp = compareRevocationFrontiers([], [rev('account', 1)]);
    expect(cmp.weAreBehind).toHaveLength(1);
    expect(cmp.remoteIsBehind).toHaveLength(0);
  });

  it('reports neither behind when epochs are equal', () => {
    const cmp = compareRevocationFrontiers([rev('global', 4)], [rev('global', 4)]);
    expect(cmp.weAreBehind).toHaveLength(0);
    expect(cmp.remoteIsBehind).toHaveLength(0);
  });
});
