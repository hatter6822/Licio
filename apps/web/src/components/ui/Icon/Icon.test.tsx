// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Icon } from './Icon.js';
import { iconNames } from './icons.js';

describe('Icon', () => {
  it('is decorative (aria-hidden, no role) when no title is given', () => {
    const { container } = render(<Icon name="check" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(svg?.querySelector('title')).toBeNull();
  });

  it('exposes an accessible name when meaningful (role="img" + <title>)', () => {
    const { getByRole } = render(<Icon name="check-circle" title="Saved" />);
    const svg = getByRole('img', { name: 'Saved' });
    expect(svg).toBeInTheDocument();
    expect(svg).not.toHaveAttribute('aria-hidden');
  });

  it('inherits currentColor and is not keyboard-focusable', () => {
    const { container } = render(<Icon name="eye" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('focusable', 'false');
  });

  it('sizes via className utilities, defaulting to size-5', () => {
    const { container, rerender } = render(<Icon name="x" />);
    expect(container.querySelector('svg')).toHaveClass('size-5');
    rerender(<Icon name="x" className="size-6" />);
    expect(container.querySelector('svg')).toHaveClass('size-6');
  });

  it('renders every registry icon without error', () => {
    for (const name of iconNames) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelector('svg')).toBeInTheDocument();
      unmount();
    }
  });

  it('has no axe violations for decorative or meaningful usage', async () => {
    const { container } = render(
      <div>
        <Icon name="circle-info" title="Why you're seeing this" />
        <span>
          <Icon name="check" /> Saved
        </span>
      </div>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
