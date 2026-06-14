// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.6.2 — content rollout flags: ON by default (WS-Q is live), validated
// writes, and FAIL-CLOSED loading (a garbled value or an unreadable store
// yields OFF — the safe pre-WS-Q state). The containment-not-flaggable
// guarantee is asserted structurally + behaviorally in wsq-content-room.test.ts.
import { describe, expect, it } from 'vitest';
import type { PwattConfigStore } from '../events/stores.js';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import {
  CONTENT_FLAG_NAMES,
  DEFAULT_CONTENT_FLAGS,
  loadContentFlags,
  setContentFlagByName,
  validateContentFlagValue,
} from '../ingestion/content-flags.js';

describe('WS-Q.6.2 content rollout flags', () => {
  it('defaults every flag ON (the live WS-Q model) when nothing is stored', async () => {
    const flags = await loadContentFlags(new InMemoryPwattConfigStore());
    expect(flags).toEqual(DEFAULT_CONTENT_FLAGS);
    expect(DEFAULT_CONTENT_FLAGS).toEqual({
      mediaPostsEnabled: true,
      inRoomVisibilityEnabled: true,
      binaryVisibilityUi: true,
    });
  });

  it('round-trips a steward override by name', async () => {
    const store = new InMemoryPwattConfigStore();
    expect(await setContentFlagByName(store, 'content.media_posts_enabled', false)).toBe(true);
    expect(await setContentFlagByName(store, 'no.such.flag', false)).toBe(false);
    const flags = await loadContentFlags(store);
    expect(flags.mediaPostsEnabled).toBe(false);
    expect(flags.inRoomVisibilityEnabled).toBe(true); // untouched
  });

  it('validates writes per flag (the 422 path)', () => {
    expect(validateContentFlagValue('content.in_room_visibility_enabled', true)).toBeNull();
    expect(validateContentFlagValue('content.in_room_visibility_enabled', 'yes')).not.toBeNull();
    expect(validateContentFlagValue('unknown.flag', true)).toMatch(/unknown/);
    expect(CONTENT_FLAG_NAMES).toContain('rooms.binary_visibility_ui');
  });

  it('fails CLOSED (flag OFF) on a garbled stored value', async () => {
    const store = new InMemoryPwattConfigStore();
    await store.set('content.media_posts_enabled', { value: 'not-a-boolean' });
    const seen: string[] = [];
    const flags = await loadContentFlags(store, (name) => seen.push(name));
    expect(flags.mediaPostsEnabled).toBe(false);
    expect(seen).toContain('content.media_posts_enabled');
  });

  it('fails CLOSED (every flag OFF) when the store read throws', async () => {
    const throwingStore: PwattConfigStore = {
      get: async () => {
        throw new Error('redis unreachable');
      },
      set: async () => {},
      clear: async () => {},
    };
    const seen: string[] = [];
    const flags = await loadContentFlags(throwingStore, (name) => seen.push(name));
    expect(flags).toEqual({
      mediaPostsEnabled: false,
      inRoomVisibilityEnabled: false,
      binaryVisibilityUi: false,
    });
    expect(seen.length).toBe(3);
  });
});
