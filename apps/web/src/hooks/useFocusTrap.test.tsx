// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
