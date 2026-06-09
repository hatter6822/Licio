// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Avatar } from './Avatar.js';

describe('Avatar', () => {
  it('renders an <img> with the name as alt text when src is given', () => {
    render(<Avatar src="/u/ada.png" name="Ada Lovelace" />);
    const img = screen.getByRole('img', { name: 'Ada Lovelace' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', '/u/ada.png');
  });

  it('renders an empty alt for decorative images', () => {
    const { container } = render(<Avatar src="/u/ada.png" name="Ada Lovelace" decorative />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('alt', '');
    // Decorative images are excluded from the accessibility tree.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('falls back to initials with role=img and an aria-label', () => {
    render(<Avatar name="Ada Lovelace" />);
    const fallback = screen.getByRole('img', { name: 'Ada Lovelace' });
    expect(fallback.tagName).toBe('SPAN');
    expect(fallback).toHaveTextContent('AL');
  });

  it('uses a single initial for a one-word name', () => {
    render(<Avatar name="Grace" />);
    expect(screen.getByRole('img', { name: 'Grace' })).toHaveTextContent('G');
  });

  it('hides the initials fallback from assistive tech when decorative', () => {
    const { container } = render(<Avatar name="Ada Lovelace" decorative />);
    const fallback = container.firstElementChild as HTMLElement;
    expect(fallback).toHaveAttribute('aria-hidden', 'true');
    expect(fallback).not.toHaveAttribute('role', 'img');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('NEVER renders any applause adornment (no count/ring/badge)', () => {
    const { container } = render(<Avatar src="/u/ada.png" name="Ada Lovelace" />);
    // No follower/popularity count text anywhere.
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-count]')).toBeNull();
    // Exactly one element: the image itself, with no sibling adornment.
    expect(container.children).toHaveLength(1);

    const { container: initialsContainer } = render(<Avatar name="Ada Lovelace" />);
    // The initials fallback has only the text node — no nested badge/ring element.
    const fallback = initialsContainer.firstElementChild as HTMLElement;
    expect(fallback.children).toHaveLength(0);
    expect(fallback.textContent).toBe('AL');
    expect(initialsContainer.querySelector('[data-count]')).toBeNull();
  });

  it('has no axe violations for image, initials, and decorative variants', async () => {
    const { container } = render(
      <div>
        <Avatar src="/u/ada.png" name="Ada Lovelace" />
        <Avatar name="Grace Hopper" />
        <span>
          <Avatar name="Linus Torvalds" decorative /> Linus Torvalds
        </span>
      </div>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
