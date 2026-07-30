// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap.js';

function Trap({ active, withFocusable }: { active: boolean; withFocusable: boolean }) {
  const ref = useFocusTrap<HTMLDivElement>(active);
  return (
    <div>
      <button type="button">outside</button>
      <div ref={ref} data-testid="trap">
        {withFocusable ? (
          <>
            <button type="button">a</button>
            <button type="button">b</button>
          </>
        ) : (
          <p>no focusable</p>
        )}
      </div>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('wraps Tab at the last element and Shift+Tab at the first', () => {
    render(<Trap active withFocusable />);
    const a = screen.getByRole('button', { name: 'a' });
    const b = screen.getByRole('button', { name: 'b' });

    b.focus();
    fireEvent.keyDown(b, { key: 'Tab' });
    expect(a).toHaveFocus(); // wrapped to first

    a.focus();
    fireEvent.keyDown(a, { key: 'Tab', shiftKey: true });
    expect(b).toHaveFocus(); // wrapped to last
  });

  it('focuses the container when the trap has no focusable elements', () => {
    render(<Trap active withFocusable={false} />);
    const container = screen.getByTestId('trap');
    expect(container).toHaveFocus(); // initial focus falls back to the container
    expect(container).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(container, { key: 'Tab' });
    expect(container).toHaveFocus(); // Tab is contained, focus stays
  });

  it('pulls focus back inside when it has escaped the trap', () => {
    render(<Trap active withFocusable />);
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    expect(outside).toHaveFocus();

    fireEvent.keyDown(outside, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'a' })).toHaveFocus(); // pulled to first inside
  });

  it('marks siblings inert while active and restores focus on deactivate', () => {
    const { rerender } = render(<Trap active={false} withFocusable />);
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();

    rerender(<Trap active withFocusable />);
    expect(screen.getByTestId('trap').contains(document.activeElement)).toBe(true);

    rerender(<Trap active={false} withFocusable />);
    expect(outside).toHaveFocus(); // focus restored to the pre-trap element
  });
});

describe('nested traps', () => {
  // `Dialog` portals to `document.body`, so a dialog rendered inside another is a
  // DOM SIBLING of it. Both traps listen on `document` in the capture phase and
  // the outer registered first, so it ran first, saw focus outside ITS container,
  // and preventDefault()ed every Tab raised in the inner dialog — with `inert`
  // support its own `first.focus()` no-ops, so focus never moved at all.
  function Nested({
    onOuterEscape,
    onInnerEscape,
  }: {
    onOuterEscape: () => void;
    onInnerEscape: () => void;
  }): React.ReactElement {
    const outer = useFocusTrap<HTMLDivElement>(true, { onEscape: onOuterEscape });
    const inner = useFocusTrap<HTMLDivElement>(true, { onEscape: onInnerEscape });
    return (
      <>
        <div ref={outer} data-testid="outer">
          <button type="button">outer-a</button>
          <button type="button">outer-b</button>
        </div>
        <div ref={inner} data-testid="inner">
          <button type="button">inner-a</button>
          <button type="button">inner-b</button>
        </div>
      </>
    );
  }

  it('lets Tab move WITHIN the inner trap instead of being cancelled by the outer one', async () => {
    const user = userEvent.setup();
    render(<Nested onOuterEscape={vi.fn()} onInnerEscape={vi.fn()} />);
    const innerA = screen.getByRole('button', { name: 'inner-a' });
    const innerB = screen.getByRole('button', { name: 'inner-b' });
    innerA.focus();
    expect(innerA).toHaveFocus();
    await user.tab();
    // Before the fix focus stayed parked on `inner-a` through every Tab.
    expect(innerB).toHaveFocus();
  });

  it('wraps at the end of the INNER trap, not into the outer one', async () => {
    const user = userEvent.setup();
    render(<Nested onOuterEscape={vi.fn()} onInnerEscape={vi.fn()} />);
    screen.getByRole('button', { name: 'inner-b' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'inner-a' })).toHaveFocus();
  });

  it('sends Escape to the INNER trap only', async () => {
    const onOuterEscape = vi.fn();
    const onInnerEscape = vi.fn();
    const user = userEvent.setup();
    render(<Nested onOuterEscape={onOuterEscape} onInnerEscape={onInnerEscape} />);
    screen.getByRole('button', { name: 'inner-a' }).focus();
    await user.keyboard('{Escape}');
    expect(onInnerEscape).toHaveBeenCalledTimes(1);
    // One key press closing two dialogs is the same bug from the other side.
    expect(onOuterEscape).not.toHaveBeenCalled();
  });

  it('still pulls focus in when it is outside EVERY trap', async () => {
    // The original guarantee must survive: a trap with focus nowhere near it still
    // claims the next Tab.
    const user = userEvent.setup();
    render(<Nested onOuterEscape={vi.fn()} onInnerEscape={vi.fn()} />);
    document.body.focus();
    await user.tab();
    const focused = document.activeElement;
    expect(
      screen.getByTestId('outer').contains(focused) ||
        screen.getByTestId('inner').contains(focused),
    ).toBe(true);
  });
});
