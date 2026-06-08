// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { type ToastOptions, ToastProvider, useToast } from './Toast.js';

/**
 * Captures the imperative `toast` function so a test can fire toasts on demand.
 * Rendering the harness does not itself create any toast.
 */
function ToastCapture({
  onReady,
}: { onReady: (toast: (o: ToastOptions) => void) => void }): ReactElement {
  const { toast } = useToast();
  useEffect(() => {
    onReady(toast);
  }, [onReady, toast]);
  return <button type="button">app</button>;
}

/**
 * Render a provider and return a `fire(options)` helper bound to the live
 * `toast` API. `fire` wraps the state update in `act`, so it is safe under both
 * real and fake timers.
 */
function setup(): { fire: (options: ToastOptions) => void } {
  let toastFn: ((o: ToastOptions) => void) | undefined;
  render(
    <ToastProvider>
      <ToastCapture
        onReady={(t) => {
          toastFn = t;
        }}
      />
    </ToastProvider>,
  );
  return {
    fire: (options) => {
      act(() => {
        toastFn?.(options);
      });
    },
  };
}

/** The live region is the single announcer; find it by its ARIA contract. */
function getLiveRegion(): HTMLElement {
  const region = document.querySelector('[aria-live="polite"]');
  if (region === null) {
    throw new Error('expected an aria-live region to be rendered');
  }
  return region as HTMLElement;
}

describe('Toast', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws if useToast is used outside a ToastProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Orphan(): ReactElement {
      useToast();
      return <span />;
    }
    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });

  it('announces a toast via an aria-live="polite", aria-atomic="false" region', () => {
    const { fire } = setup();
    fire({ message: 'Draft saved', duration: Number.POSITIVE_INFINITY });
    const region = getLiveRegion();
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'false');
    expect(within(region).getByText('Draft saved')).toBeInTheDocument();
  });

  it('renders the tone icon plus text so colour is never the sole signal', () => {
    const { fire } = setup();
    fire({ message: 'Upload failed', tone: 'error', duration: Number.POSITIVE_INFINITY });
    const item = getLiveRegion().querySelector('[data-toast]') as HTMLElement;
    expect(within(item).getByText('Upload failed')).toBeInTheDocument();
    // Tone icon (an inline svg) renders alongside the text.
    expect(item.querySelector('svg')).not.toBeNull();
  });

  it('does not render a status icon for the neutral (tone-less) toast', () => {
    const { fire } = setup();
    fire({ message: 'Plain note', duration: Number.POSITIVE_INFINITY });
    const item = getLiveRegion().querySelector('[data-toast]') as HTMLElement;
    // Only the dismiss button's "x" svg is present — no leading status icon.
    expect(item.querySelectorAll('svg')).toHaveLength(1);
  });

  describe('auto-dismiss timing (fake timers)', () => {
    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it('auto-dismisses after the default 5000ms duration', () => {
      vi.useFakeTimers();
      const { fire } = setup();
      fire({ message: 'Auto bye' });
      expect(screen.getByText('Auto bye')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(4999);
      });
      expect(screen.getByText('Auto bye')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByText('Auto bye')).not.toBeInTheDocument();
    });

    it('honours a custom duration', () => {
      vi.useFakeTimers();
      const { fire } = setup();
      fire({ message: 'Quick', duration: 1000 });
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(screen.getByText('Quick')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByText('Quick')).not.toBeInTheDocument();
    });

    it('pauses the auto-dismiss timer while the pointer hovers the toast', () => {
      vi.useFakeTimers();
      const { fire } = setup();
      fire({ message: 'Hover me', duration: 2000 });
      const item = getLiveRegion().querySelector('[data-toast]') as HTMLElement;

      // Hover before the timer fires; advancing far past the duration must NOT
      // dismiss while hovered.
      act(() => {
        fireEvent.mouseEnter(item);
      });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText('Hover me')).toBeInTheDocument();

      // Leaving resumes the countdown from the start.
      act(() => {
        fireEvent.mouseLeave(item);
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText('Hover me')).not.toBeInTheDocument();
    });

    it('pauses the auto-dismiss timer while focus is within the toast', () => {
      vi.useFakeTimers();
      const { fire } = setup();
      fire({
        message: 'Focus me',
        duration: 2000,
        action: { label: 'Undo', onAction: () => undefined },
      });
      const item = getLiveRegion().querySelector('[data-toast]') as HTMLElement;
      const undo = within(item).getByRole('button', { name: 'Undo' });

      // Focus into the toast; the timer must hold.
      act(() => {
        undo.focus();
        fireEvent.focus(item);
      });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText('Focus me')).toBeInTheDocument();

      // Blur out of the toast entirely resumes the countdown.
      act(() => {
        fireEvent.blur(item);
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText('Focus me')).not.toBeInTheDocument();
    });
  });

  it('dismisses via the close button on click', async () => {
    const user = userEvent.setup();
    const { fire } = setup();
    fire({ message: 'Closeable', duration: Number.POSITIVE_INFINITY });
    const close = screen.getByRole('button', { name: 'Dismiss' });
    expect(close).toHaveClass('min-h-touch', 'min-w-touch');
    await user.click(close);
    expect(screen.queryByText('Closeable')).not.toBeInTheDocument();
  });

  it('dismisses via the close button with the keyboard (Enter)', async () => {
    const user = userEvent.setup();
    const { fire } = setup();
    fire({ message: 'Key close', duration: Number.POSITIVE_INFINITY });
    const close = screen.getByRole('button', { name: 'Dismiss' });
    act(() => {
      close.focus();
    });
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Key close')).not.toBeInTheDocument();
  });

  it('runs the action then dismisses', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { fire } = setup();
    fire({
      message: 'With action',
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Retry', onAction },
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByText('With action')).not.toBeInTheDocument();
  });

  it('stacks multiple toasts in order, all inside the one live region', () => {
    const { fire } = setup();
    fire({ message: 'First', duration: Number.POSITIVE_INFINITY });
    fire({ message: 'Second', duration: Number.POSITIVE_INFINITY });
    fire({ message: 'Third', duration: Number.POSITIVE_INFINITY });

    const items = getLiveRegion().querySelectorAll('[data-toast]');
    expect(items).toHaveLength(3);
    const text = Array.from(items, (el) => el.textContent ?? '');
    expect(text[0]).toContain('First');
    expect(text[1]).toContain('Second');
    expect(text[2]).toContain('Third');
  });

  it('dismisses only the targeted toast, leaving the others', async () => {
    const user = userEvent.setup();
    const { fire } = setup();
    fire({ message: 'Keep me', duration: Number.POSITIVE_INFINITY });
    fire({ message: 'Remove me', duration: Number.POSITIVE_INFINITY });

    const removeItem = screen.getByText('Remove me').closest('[data-toast]') as HTMLElement;
    await user.click(within(removeItem).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Remove me')).not.toBeInTheDocument();
    expect(screen.getByText('Keep me')).toBeInTheDocument();
  });

  it('has no axe violations with a stacked, toned, actionable toast set', async () => {
    const { fire } = setup();
    fire({ message: 'Saved', tone: 'success', duration: Number.POSITIVE_INFINITY });
    fire({ message: 'Heads up', tone: 'warning', duration: Number.POSITIVE_INFINITY });
    fire({
      message: 'Failed',
      tone: 'error',
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Retry', onAction: () => undefined },
    });
    fire({ message: 'Plain note', duration: Number.POSITIVE_INFINITY });
    expect(await checkA11y(getLiveRegion())).toHaveNoViolations();
  });
});
