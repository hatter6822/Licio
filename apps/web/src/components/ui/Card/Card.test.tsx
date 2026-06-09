// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Card } from './Card.js';

describe('Card', () => {
  it('renders an <article> by default', () => {
    const { container } = render(<Card>Content</Card>);
    expect((container.firstElementChild as HTMLElement).tagName).toBe('ARTICLE');
  });

  it('renders the chosen semantic element', () => {
    const { container, rerender } = render(<Card as="section">Body</Card>);
    expect((container.firstElementChild as HTMLElement).tagName).toBe('SECTION');
    rerender(<Card as="div">Body</Card>);
    expect((container.firstElementChild as HTMLElement).tagName).toBe('DIV');
  });

  it('does not inject a heading and preserves children hierarchy', () => {
    render(
      <Card>
        <h2>Thread title</h2>
        <p>Body text</p>
      </Card>,
    );
    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Thread title');
    expect(headings[0]?.tagName).toBe('H2');
  });

  it('renders the whole card as a single link when interactive with href', () => {
    const { container } = render(
      <Card interactive href="/threads/1">
        <h3>Heading</h3>
        <p>Read more</p>
      </Card>,
    );
    const link = screen.getByRole('link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/threads/1');
    // Exactly one focusable element for the whole surface.
    expect(container.querySelectorAll('a, button')).toHaveLength(1);
  });

  it('renders the whole card as a single button when interactive with onClick and no href', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { container } = render(
      <Card interactive onClick={onClick}>
        <h3>Tappable</h3>
      </Card>,
    );
    const button = screen.getByRole('button');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(container.querySelectorAll('a, button')).toHaveLength(1);

    // Keyboard-activatable as a native button (Enter and Space).
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('is not focusable when non-interactive', () => {
    const { container } = render(<Card>Static</Card>);
    expect(container.querySelectorAll('a, button')).toHaveLength(0);
  });

  it('has no axe violations for static, link, and button cards', async () => {
    const { container } = render(
      <div>
        <Card>
          <h2>Static card</h2>
          <p>Body</p>
        </Card>
        <Card interactive href="/x">
          <h2>Link card</h2>
        </Card>
        <Card interactive onClick={() => undefined}>
          <h2>Button card</h2>
        </Card>
      </div>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
