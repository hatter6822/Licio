// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen, waitForElementToBeRemoved } from '@testing-library/react';
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

/** The decorative drag-handle region carries the pointer-drag listeners. */
function dragHandle(): HTMLElement {
  const handle = document.querySelector('.cursor-grab');
  if (!handle) throw new Error('drag handle not found');
  return handle as HTMLElement;
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
    // Focus returns to the opener immediately (keyed to `open`), even while the
    // panel is still sliding away.
    expect(trigger).toHaveFocus();
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'));
  });

  it('dismisses on a downward pointer drag past the threshold', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const handle = dragHandle();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 320 }); // 220px down
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 320 });
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'));
  });

  it('ignores a small drag that does not cross the threshold', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const handle = dragHandle();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 130 }); // 30px down
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 130 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('dismisses via the close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'));
  });

  it('plays an exit animation: stays mounted briefly on close, then unmounts', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await user.keyboard('{Escape}');
    // Immediately after close the panel is still in the DOM — sliding out, not
    // removed — which is the whole point of an exit animation…
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // …and it unmounts once the transition (or its fallback timer) completes.
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'));
  });

  it('unmounts immediately under reduced motion (no exit animation)', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    // matchMedia is absent in jsdom; provide one that reports reduced motion.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('reduce'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    try {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'Open sheet' }));
      await user.keyboard('{Escape}');
      // No animation to wait on — the dialog is gone synchronously with the close.
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('has no axe violations when open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    expect(await checkA11y(baseElement)).toHaveNoViolations();
  });

  // `cn` does not resolve Tailwind conflicts, so a hard-coded default width in
  // the base list would silently beat the caller's — the wide sheets (the
  // debate arena's side-by-side columns, the live-debates list) would render at
  // the narrow default with no error anywhere.
  it('defaults to max-w-xl but yields that width to a caller that sets its own', () => {
    const { rerender } = render(
      <Sheet open onClose={() => undefined} title="Context">
        <p>Body</p>
      </Sheet>,
    );
    expect(screen.getByRole('dialog')).toHaveClass('max-w-xl');

    rerender(
      <Sheet open onClose={() => undefined} title="Context" className="max-w-3xl">
        <p>Body</p>
      </Sheet>,
    );
    const sheet = screen.getByRole('dialog');
    expect(sheet).toHaveClass('max-w-3xl');
    expect(sheet).not.toHaveClass('max-w-xl');
  });
});
