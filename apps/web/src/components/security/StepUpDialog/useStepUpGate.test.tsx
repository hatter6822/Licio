// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The step-up retry gate (WS-D.1.3e): a challenged action stays pending, a
// satisfied step-up retries the SAME action and settles the ORIGINAL promise,
// and dismissal rejects with the original challenge.  Non-step-up failures
// pass straight through.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StepUpRequiredError } from '../../../lib/auth-api.js';
import { useStepUpGate } from './useStepUpGate.js';

const flush = () => act(async () => {});

describe('useStepUpGate', () => {
  it('passes a successful action straight through (dialog stays closed)', async () => {
    const { result } = renderHook(() => useStepUpGate());
    await expect(result.current.guard(async () => 'ok')).resolves.toBe('ok');
    expect(result.current.dialog.open).toBe(false);
  });

  it('rejects immediately on a non-step-up failure', async () => {
    const { result } = renderHook(() => useStepUpGate());
    await expect(
      result.current.guard(async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(result.current.dialog.open).toBe(false);
  });

  it('opens the dialog on a challenge and retries the SAME action when satisfied', async () => {
    const { result } = renderHook(() => useStepUpGate());
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new StepUpRequiredError(['webauthn']))
      .mockResolvedValueOnce('done-after-stepup');

    let outcome: Promise<string> | undefined;
    act(() => {
      outcome = result.current.guard(action);
      outcome.catch(() => undefined); // observed below; avoid unhandled rejection
    });
    await flush();
    expect(result.current.dialog.open).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);

    act(() => result.current.dialog.onSatisfied());
    await expect(outcome).resolves.toBe('done-after-stepup');
    expect(action).toHaveBeenCalledTimes(2);
    expect(result.current.dialog.open).toBe(false);
  });

  it('rejects with the original challenge when the dialog is dismissed', async () => {
    const { result } = renderHook(() => useStepUpGate());
    const action = vi.fn(async () => {
      throw new StepUpRequiredError(['email_otp']);
    });

    let outcome: Promise<unknown> | undefined;
    act(() => {
      outcome = result.current.guard(action);
      outcome.catch(() => undefined);
    });
    await flush();
    expect(result.current.dialog.open).toBe(true);

    act(() => result.current.dialog.onClose());
    await expect(outcome).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(action).toHaveBeenCalledTimes(1); // never retried without a step-up
  });
});
