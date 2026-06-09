// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Button } from '../Button/index.js';
import { Dialog } from './Dialog.js';

function Harness({ closeOnBackdrop = true }: { closeOnBackdrop?: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Confirm action"
        closeOnBackdrop={closeOnBackdrop}
      >
        <p>Dialog body</p>
        <Button onClick={() => setOpen(false)}>OK</Button>
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  it('is not rendered while closed and is a labelled modal when open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Confirm action');
  });

  it('moves focus into the dialog on open and marks the background inert', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    // The trigger's top-level (body-child) container is inert while open.
    let topLevel: HTMLElement = trigger;
    while (topLevel.parentElement && topLevel.parentElement !== document.body) {
      topLevel = topLevel.parentElement;
    }
    expect(topLevel.hasAttribute('inert')).toBe(true);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on backdrop click only when enabled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness closeOnBackdrop={false} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    // Backdrop is the aria-hidden button behind the panel.
    const backdrop = document.querySelector('[aria-hidden="true"].bg-black\\/50') as HTMLElement;
    await user.click(backdrop);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rerender(<Harness closeOnBackdrop={true} />);
    await user.click(document.querySelector('[aria-hidden="true"].bg-black\\/50') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes via the labelled close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('traps Tab focus within the dialog (wraps at the ends)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog');
    // Tab around several times; focus must never leave the dialog.
    for (let i = 0; i < 5; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('has no axe violations when open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await checkA11y(baseElement)).toHaveNoViolations();
  });
});
