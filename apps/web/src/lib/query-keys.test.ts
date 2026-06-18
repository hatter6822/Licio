// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys.js';

describe('queryKeys', () => {
  it('produces consistent, serializable tuple keys', () => {
    expect(queryKeys.feed()).toEqual(['feed', 'balanced']);
    expect(queryKeys.feed('chronological')).toEqual(['feed', 'chronological']);
    expect(queryKeys.story('s1')).toEqual(['story', 's1']);
    expect(queryKeys.thread('t1')).toEqual(['thread', 't1']);
    expect(queryKeys.storyComments('s1', { filter: 'sources' })).toEqual([
      'story',
      's1',
      'comments',
      { filter: 'sources' },
    ]);
    expect(queryKeys.rooms()).toEqual(['rooms']);
    expect(queryKeys.room('r1')).toEqual(['room', 'r1']);
    expect(queryKeys.authStatus()).toEqual(['auth-status']);
    expect(queryKeys.settings()).toEqual(['settings']);
    expect(queryKeys.signalLedger()).toEqual(['signal-ledger']);
    expect(queryKeys.featureFlags()).toEqual(['feature-flags']);
    expect(queryKeys.notificationPreferences()).toEqual(['notification-preferences']);
  });

  it('keys are stable across calls (used for invalidation)', () => {
    expect(queryKeys.thread('t1')).toEqual(queryKeys.thread('t1'));
  });
});
