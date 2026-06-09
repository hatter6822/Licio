// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Separator } from './Separator.js';

describe('Separator', () => {
  it('is decorative (aria-hidden, no role) by default', () => {
    const { container } = render(<Separator />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe('DIV');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).not.toHaveAttribute('role');
    expect(el).toHaveClass('bg-line');
  });

  it('defaults to a horizontal hairline', () => {
    const { container } = render(<Separator />);
    expect(container.firstElementChild).toHaveClass('h-px', 'w-full');
  });

  it('exposes role=separator with aria-orientation when not decorative', () => {
    render(<Separator decorative={false} />);
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('renders a vertical separator with the matching orientation', () => {
    const { container, rerender } = render(<Separator orientation="vertical" />);
    expect(container.firstElementChild).toHaveClass('h-full', 'w-px');
    rerender(<Separator orientation="vertical" decorative={false} />);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('appends consumer className last', () => {
    const { container } = render(<Separator className="my-4" />);
    expect(container.firstElementChild).toHaveClass('bg-line', 'my-4');
  });

  it('carries no applause/count adornment', () => {
    const { container } = render(<Separator />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-count]')).toBeNull();
  });

  it('has no axe violations for decorative and semantic separators', async () => {
    const { container } = render(
      <div>
        <p>Above</p>
        <Separator />
        <p>Between</p>
        <Separator decorative={false} />
        <p>Below</p>
        <span>
          Left
          <Separator orientation="vertical" decorative={false} />
          Right
        </span>
      </div>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
