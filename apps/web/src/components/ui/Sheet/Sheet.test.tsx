// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Sheet } from './Sheet.js';

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Context">
        <p>Sheet body</p>
        <a href="/more">More</a>
      </Sheet>
    </div>
  );
}

describe('Sheet', () => {
  it('renders as a labelled modal and traps focus on open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const sheet = screen.getByRole('dialog');
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(sheet).toHaveAccessibleName('Context');
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it('locks body scroll while open and restores it on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('');
  });

  it('dismisses on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open sheet' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('dismisses on a downward swipe past the threshold', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.touchStart(sheet, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(sheet, { changedTouches: [{ clientY: 300 }] });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a small swipe that does not cross the threshold', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.touchStart(sheet, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(sheet, { changedTouches: [{ clientY: 130 }] });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('dismisses via the close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no axe violations when open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    expect(await checkA11y(baseElement)).toHaveNoViolations();
  });
});
