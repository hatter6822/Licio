// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Button, type ButtonVariant } from './Button.js';

const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive'];

describe('Button', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a <button> by default and an <a> when href is given', () => {
    const { rerender } = render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).tagName).toBe('BUTTON');
    rerender(<Button href="/threads">Threads</Button>);
    const link = screen.getByRole('link', { name: 'Threads' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/threads');
  });

  it('defaults to type="button" so it never submits a form unexpectedly', () => {
    render(<Button>Action</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it.each(variants)('renders the %s variant and keeps a 48px min touch target', (variant) => {
    render(<Button variant={variant}>Label</Button>);
    expect(screen.getByRole('button', { name: 'Label' })).toHaveClass('min-h-touch');
  });

  it('activates with mouse, Enter, and Space', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    await user.click(button);
    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('blocks activation and double-submission when loading (aria-busy)', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Submit
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Submit/ });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // A visually-hidden status label is announced alongside aria-busy.
    expect(button).toHaveAccessibleName(/Loading/);
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('uses aria-disabled (not native disabled) and prevents clicks when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Disabled
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Disabled' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled(); // stays focusable & announced
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('warns in development when an icon-only button has no aria-label', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Button iconOnly aria-label="Close" />);
    expect(warn).not.toHaveBeenCalled();
    render(<Button iconOnly>x</Button>);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('cannot express an applause affordance (no count/like/vote props)', () => {
    // Type-level guarantee, asserted structurally: the rendered button exposes
    // no element carrying a popularity count.
    render(<Button>Contribute</Button>);
    const button = screen.getByRole('button', { name: 'Contribute' });
    expect(button.textContent).toBe('Contribute');
    expect(button.querySelector('[data-count]')).toBeNull();
  });

  it('has no axe violations across variants (incl. icon-only with label)', async () => {
    const { container } = render(
      <div>
        {variants.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
        <Button iconOnly aria-label="Close">
          x
        </Button>
        <Button href="/x">Link</Button>
      </div>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
