// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Tooltip } from './Tooltip.js';

function Subject({ delay }: { delay?: number }): ReactElement {
  return (
    <Tooltip content="More info" {...(delay === undefined ? {} : { delay })}>
      <button type="button">Help</button>
    </Tooltip>
  );
}

/** The wrapper carrying the hover/keydown handlers is the trigger's parent. */
function wrapperOf(trigger: HTMLElement): HTMLElement {
  return trigger.parentElement as HTMLElement;
}

describe('Tooltip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is hidden until the trigger is hovered or focused', () => {
    render(<Subject />);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('opens immediately on keyboard focus and links via aria-describedby', async () => {
    const user = userEvent.setup();
    render(<Subject />);
    const trigger = screen.getByRole('button', { name: 'Help' });

    await user.tab();
    expect(trigger).toHaveFocus();

    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('More info');
    // The trigger names the tooltip as its description, by id.
    expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('preserves a pre-existing aria-describedby on the trigger', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Tip">
        <button type="button" aria-describedby="ext">
          Help
        </button>
      </Tooltip>,
    );
    await user.tab();
    const trigger = screen.getByRole('button', { name: 'Help' });
    const tip = screen.getByRole('tooltip');
    expect(trigger.getAttribute('aria-describedby')).toContain('ext');
    expect(trigger.getAttribute('aria-describedby')).toContain(tip.id);
  });

  it('hides on blur when not hovered', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Subject />
        <button type="button">elsewhere</button>
      </>,
    );
    await user.tab(); // focus Help -> tooltip shows
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.tab(); // focus the next button -> blur Help
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('Escape hides the tooltip while keeping focus on the trigger (dismissible)', async () => {
    const user = userEvent.setup();
    render(<Subject />);
    const trigger = screen.getByRole('button', { name: 'Help' });

    await user.tab();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    // Focus is unchanged — the pointer never moved and focus stayed put.
    expect(trigger).toHaveFocus();
  });

  it('does not cover its trigger (rendered as an adjacent sibling)', async () => {
    const user = userEvent.setup();
    render(<Subject />);
    const trigger = screen.getByRole('button', { name: 'Help' });
    await user.tab();
    const tip = screen.getByRole('tooltip');
    // The tooltip is a sibling of the trigger inside the wrapper, not a wrapper
    // around (covering) the trigger.
    expect(tip).not.toContainElement(trigger);
    expect(wrapperOf(trigger)).toContainElement(tip);
  });

  describe('hover timing (fake timers)', () => {
    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it('opens on hover only after the delay elapses', () => {
      vi.useFakeTimers();
      render(<Subject delay={300} />);
      const wrapper = wrapperOf(screen.getByRole('button', { name: 'Help' }));

      act(() => {
        fireEvent.mouseEnter(wrapper);
      });
      // Not yet — still within the delay window.
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole('tooltip')).toHaveTextContent('More info');
    });

    it('stays open when the pointer moves from the trigger onto the tooltip (hoverable)', () => {
      vi.useFakeTimers();
      render(<Subject delay={0} />);
      const wrapper = wrapperOf(screen.getByRole('button', { name: 'Help' }));

      act(() => {
        fireEvent.mouseEnter(wrapper);
        vi.advanceTimersByTime(0);
      });
      const tip = screen.getByRole('tooltip');
      expect(tip).toBeInTheDocument();

      // The bubble lives inside the wrapper, so moving the pointer from the
      // trigger onto the bubble fires no `mouseleave` on the wrapper — entering
      // the bubble must not dismiss it.
      act(() => {
        fireEvent.mouseEnter(tip);
      });
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });

    it('hides once the pointer leaves the whole group', () => {
      vi.useFakeTimers();
      render(<Subject delay={0} />);
      const wrapper = wrapperOf(screen.getByRole('button', { name: 'Help' }));

      act(() => {
        fireEvent.mouseEnter(wrapper);
        vi.advanceTimersByTime(0);
      });
      expect(screen.getByRole('tooltip')).toBeInTheDocument();

      act(() => {
        fireEvent.mouseLeave(wrapper);
      });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('cancels a pending hover-open if the pointer leaves before the delay', () => {
      vi.useFakeTimers();
      render(<Subject delay={300} />);
      const wrapper = wrapperOf(screen.getByRole('button', { name: 'Help' }));

      act(() => {
        fireEvent.mouseEnter(wrapper);
        vi.advanceTimersByTime(150);
        fireEvent.mouseLeave(wrapper);
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  it('has no axe violations while shown', async () => {
    const user = userEvent.setup();
    const { container } = render(<Subject />);
    await user.tab();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('Tooltip singleton (only one bubble at a time)', () => {
  function Row(): ReactElement {
    return (
      <div>
        <Tooltip content="Correct">
          <button type="button">A</button>
        </Tooltip>
        <Tooltip content="Save for offline">
          <button type="button">B</button>
        </Tooltip>
      </div>
    );
  }

  it('a second tooltip opening closes the first — even while the first is focus-open', async () => {
    const user = userEvent.setup();
    render(<Row />);
    const a = screen.getByRole('button', { name: 'A' });
    const b = screen.getByRole('button', { name: 'B' });

    // Press A: focus holds its tooltip open…
    a.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Correct');

    // …and moving to the neighbour must not leave TWO overlapping bubbles on a
    // 48px icon row: focusing B takes over.
    act(() => b.focus());
    const tips = screen.getAllByRole('tooltip');
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveTextContent('Save for offline');
    await user.keyboard('{Escape}');
  });

  it('hover on a neighbour also takes over from a focus-open tooltip', () => {
    vi.useFakeTimers();
    try {
      render(<Row />);
      const a = screen.getByRole('button', { name: 'A' });
      const b = screen.getByRole('button', { name: 'B' });
      act(() => a.focus());
      expect(screen.getAllByRole('tooltip')).toHaveLength(1);

      fireEvent.mouseEnter(wrapperOf(b));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      const tips = screen.getAllByRole('tooltip');
      expect(tips).toHaveLength(1);
      expect(tips[0]).toHaveTextContent('Save for offline');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Tooltip placement', () => {
  it('centres by default and aligns to an inline edge on request', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Tooltip content="Correct">
        <button type="button">Edge</button>
      </Tooltip>,
    );
    await user.tab();
    expect(screen.getByRole('tooltip').className).toContain('-translate-x-1/2');

    // A control at the START of a row grows inward instead of off-screen.
    rerender(
      <Tooltip content="Correct" placement="start">
        <button type="button">Edge</button>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip').className).toContain('start-0');
    expect(screen.getByRole('tooltip').className).not.toContain('-translate-x-1/2');

    rerender(
      <Tooltip content="Correct" placement="end">
        <button type="button">Edge</button>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip').className).toContain('end-0');
  });
});
