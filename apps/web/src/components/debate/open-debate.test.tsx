// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The debate surfaces' HISTORY contract: opening pushes an entry (so the back
// gesture closes the modal), and closing CONSUMES that entry rather than
// replacing it with a duplicate URL — otherwise the stack ends up holding the
// same page twice and the next back press looks like it did nothing. A
// cold-loaded deep link has nothing to pop, so there the closer clears the
// params in place.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
const historyBack = vi.fn();
let canGoBack = true;

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useCanGoBack: () => canGoBack,
  useRouter: () => ({ history: { back: historyBack } }),
}));

const { useCloseDebate, useCloseDebateList, useOpenDebate, useOpenDebateList } = await import(
  './open-debate.js'
);

/** The search updater the hook passed to `navigate`, applied to `prev`. */
function searchAfter(prev: Record<string, unknown>): Record<string, unknown> {
  const call = navigate.mock.calls.at(-1)?.[0] as {
    replace?: boolean;
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
  };
  return call.search(prev);
}

describe('debate modal navigation', () => {
  beforeEach(() => {
    navigate.mockReset();
    historyBack.mockReset();
    canGoBack = true;
  });

  it('opening PUSHES, so the back gesture closes the modal', () => {
    const { result } = renderHook(() => ({
      openList: useOpenDebateList(),
      openArena: useOpenDebate(),
    }));

    result.current.openList();
    expect(navigate.mock.calls.at(-1)?.[0]).not.toHaveProperty('replace', true);
    expect(searchAfter({})).toEqual({ debates: true });

    result.current.openArena('99999999-9999-4999-8999-999999999999');
    expect(navigate.mock.calls.at(-1)?.[0]).not.toHaveProperty('replace', true);
    // The list param SURVIVES, so closing the arena lands back in the list.
    expect(searchAfter({ debates: true })).toEqual({
      debates: true,
      debate: '99999999-9999-4999-8999-999999999999',
    });
  });

  it('closing CONSUMES the pushed entry instead of stacking a duplicate URL', () => {
    const { result } = renderHook(() => ({
      closeList: useCloseDebateList(),
      closeArena: useCloseDebate(),
    }));

    result.current.closeArena();
    expect(historyBack).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    result.current.closeList();
    expect(historyBack).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a cold-loaded deep link has no entry to pop, so it clears the params in place', () => {
    canGoBack = false;
    const { result } = renderHook(() => ({
      closeList: useCloseDebateList(),
      closeArena: useCloseDebate(),
    }));

    result.current.closeArena();
    expect(historyBack).not.toHaveBeenCalled();
    expect(navigate.mock.calls.at(-1)?.[0]).toMatchObject({ replace: true });
    expect(searchAfter({ root: 'r1', debate: 'd1' })).toEqual({ root: 'r1', debate: undefined });

    // Closing the LIST also drops any arena param beneath it, so a closed list
    // can never leave an orphaned `?debate` behind.
    result.current.closeList();
    expect(navigate.mock.calls.at(-1)?.[0]).toMatchObject({ replace: true });
    expect(searchAfter({ root: 'r1', debates: true, debate: 'd1' })).toEqual({
      root: 'r1',
      debates: undefined,
      debate: undefined,
    });
  });
});
