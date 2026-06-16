// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J production ports: removals actually propagate to the WS-E item-safety
// state (the ranking-exclusion seam) + the WS-G contribution state; account
// actions write the WS-D state; user resolution reads handle + account age.
import { describe, expect, it, vi } from 'vitest';
import { InMemoryItemSafetyStateStore } from '../events/stores.js';
import {
  type ContentPortDeps,
  createProductionContentPort,
  createProductionUserPort,
} from '../moderation/production-ports.js';

const STORY = '00000000-0000-4000-8000-00000000000a';
const CONTRIB = '00000000-0000-4000-8000-00000000000b';
const AUTHOR = '00000000-0000-4000-8000-00000000000c';

function contentDeps(over: Partial<ContentPortDeps> = {}): ContentPortDeps {
  return {
    safetyStore: new InMemoryItemSafetyStateStore(),
    getStory: async (id) => (id === STORY ? { submittedBy: AUTHOR } : null),
    getContribution: async (id) => (id === CONTRIB ? { userId: AUTHOR } : null),
    setContributionModerationState: vi.fn(async () => undefined),
    setAccountState: vi.fn(async () => undefined),
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe('production content port', () => {
  it('resolves a story target to its submitter and a contribution to its author', async () => {
    const port = createProductionContentPort(contentDeps());
    expect(await port.resolveTarget('content', STORY)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: 'story',
    });
    expect(await port.resolveTarget('content', CONTRIB)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: 'contribution',
    });
    expect(await port.resolveTarget('account', AUTHOR)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: null,
    });
    expect(
      (await port.resolveTarget('content', '00000000-0000-4000-8000-0000000000ff')).exists,
    ).toBe(false);
  });

  it('removal writes the WS-E item-safety state to removed (the ranking seam)', async () => {
    const safetyStore = new InMemoryItemSafetyStateStore();
    const setState = vi.fn(async () => undefined);
    const port = createProductionContentPort(
      contentDeps({ safetyStore, setContributionModerationState: setState }),
    );
    await port.applyContentState(STORY, 'story', 'removed', 'case-1', 'mod-1');
    expect((await safetyStore.get(STORY))?.safetyState).toBe('removed');

    await port.applyContentState(CONTRIB, 'contribution', 'hidden', null, 'mod-1');
    expect((await safetyStore.get(CONTRIB))?.safetyState).toBe('removed'); // hidden also excludes
    expect(setState).toHaveBeenCalledWith(CONTRIB, 'hidden');

    // A revert restores the item to normal.
    await port.applyContentState(STORY, 'story', 'visible', 'case-1', 'mod-1');
    expect((await safetyStore.get(STORY))?.safetyState).toBe('normal');
  });

  it('account action writes the coarse WS-D account state', async () => {
    const setAccountState = vi.fn(async () => undefined);
    const port = createProductionContentPort(contentDeps({ setAccountState }));
    await port.applyAccountState(AUTHOR, 'banned', null);
    expect(setAccountState).toHaveBeenCalledWith(AUTHOR, 'suspended');
    await port.applyAccountState(AUTHOR, 'active', null);
    expect(setAccountState).toHaveBeenCalledWith(AUTHOR, 'active');
  });
});

describe('production user port', () => {
  it('resolves handle + account age (days) and batches', async () => {
    const nowMs = 1_700_000_000_000;
    const created = new Date(nowMs - 10 * 86_400_000).toISOString();
    const port = createProductionUserPort({
      getUser: async (id) => (id === AUTHOR ? { handle: 'alice', createdAt: created } : null),
      getUsersByIds: async (ids) =>
        ids.includes(AUTHOR) ? [{ userId: AUTHOR, handle: 'alice', createdAt: created }] : [],
      now: () => nowMs,
    });
    const resolved = await port.resolve(AUTHOR);
    expect(resolved?.handle).toBe('alice');
    expect(resolved?.accountAgeDays).toBe(10);
    expect(await port.resolve('00000000-0000-4000-8000-0000000000ff')).toBeNull();
    const many = await port.resolveMany([AUTHOR]);
    expect(many.get(AUTHOR)?.accountAgeDays).toBe(10);
  });
});
