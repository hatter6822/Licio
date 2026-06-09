// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Skeleton } from './Skeleton.js';

describe('Skeleton', () => {
  it('renders a decorative, aria-hidden pulse block by default', () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toBeInTheDocument();
    expect(block.tagName).toBe('DIV');
    expect(block).toHaveAttribute('aria-hidden', 'true');
    expect(block).toHaveClass('animate-pulse');
    expect(block).toHaveClass('rounded-md');
    expect(block).toHaveClass('bg-surface-strong');
    expect(block).toHaveClass('h-4', 'w-32');
  });

  it('renders as a span when requested', () => {
    const { container } = render(<Skeleton as="span" />);
    expect((container.firstElementChild as HTMLElement).tagName).toBe('SPAN');
  });

  it('renders multiple pulse lines when count > 1, all aria-hidden', () => {
    const { container } = render(<Skeleton count={3} className="h-3" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    const lines = wrapper.querySelectorAll('.animate-pulse');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toHaveClass('bg-surface-strong', 'h-3');
    }
  });

  it('exposes no count/applause text', () => {
    const { container } = render(<Skeleton />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-count]')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <div aria-busy="true">
        <span className="sr-only">Loading content</span>
        <Skeleton className="h-6 w-48" />
        <Skeleton count={2} className="h-3 w-full" />
      </div>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
