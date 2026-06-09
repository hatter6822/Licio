// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPushReadiness = vi.fn();
const subscribeToPush = vi.fn();
const unsubscribeFromPush = vi.fn();

vi.mock('./subscription.js', () => ({
  getPushReadiness: () => getPushReadiness(),
  subscribeToPush: () => subscribeToPush(),
  unsubscribeFromPush: () => unsubscribeFromPush(),
}));

const { usePushControls } = await import('./use-push.js');

beforeEach(() => {
  vi.clearAllMocks();
  getPushReadiness.mockResolvedValue('ready');
  subscribeToPush.mockResolvedValue(null);
  unsubscribeFromPush.mockResolvedValue(undefined);
});

describe('usePushControls', () => {
  it('resolves readiness without prompting on mount', async () => {
    const { result } = renderHook(() => usePushControls());
    expect(result.current.readiness).toBe('loading');
    await waitFor(() => expect(result.current.readiness).toBe('ready'));
    expect(subscribeToPush).not.toHaveBeenCalled();
  });

  it('enable() subscribes then re-resolves readiness to subscribed', async () => {
    getPushReadiness.mockResolvedValueOnce('ready').mockResolvedValue('subscribed');
    const { result } = renderHook(() => usePushControls());
    await waitFor(() => expect(result.current.readiness).toBe('ready'));

    await act(async () => {
      await result.current.enable();
    });

    expect(subscribeToPush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.readiness).toBe('subscribed'));
  });

  it('disable() unsubscribes then re-resolves readiness', async () => {
    getPushReadiness.mockResolvedValueOnce('subscribed').mockResolvedValue('ready');
    const { result } = renderHook(() => usePushControls());
    await waitFor(() => expect(result.current.readiness).toBe('subscribed'));

    await act(async () => {
      await result.current.disable();
    });

    expect(unsubscribeFromPush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.readiness).toBe('ready'));
  });
});
