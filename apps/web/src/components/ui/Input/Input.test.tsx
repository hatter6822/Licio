// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Input } from './Input.js';

describe('Input', () => {
  it('associates a visible label with the field via htmlFor/id', () => {
    render(<Input label="Display name" />);
    const input = screen.getByLabelText('Display name');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('marks required fields with aria-required and a visible indicator', () => {
    render(<Input label="Email" required />);
    const input = screen.getByLabelText(/Email/);
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toBeRequired();
    // Asterisk is decorative; aria-required carries the semantics.
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });

  it('links an error via aria-describedby and sets aria-invalid', () => {
    render(<Input label="Email" error="Enter a valid email" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const message = document.getElementById(describedBy as string);
    expect(message).toHaveTextContent('Enter a valid email');
  });

  it('links helper text and keeps both helper and error in aria-describedby', () => {
    render(<Input label="Handle" helperText="3–20 characters" error="Taken" />);
    const input = screen.getByLabelText('Handle');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain('3–20 characters');
    expect(texts.some((t) => t?.includes('Taken'))).toBe(true);
  });

  it('does not steal focus when an error is present (focus stays where the user is)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Input label="Email" />);
    const input = screen.getByLabelText('Email');
    await user.click(input);
    expect(input).toHaveFocus();
    rerender(<Input label="Email" error="Invalid" />);
    expect(input).toHaveFocus();
  });

  it('keeps the label even when visually hidden and supports autocomplete tokens', () => {
    render(<Input label="Search" hideLabel autoComplete="off" />);
    const input = screen.getByLabelText('Search');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });

  it('has no axe violations in default and error states', async () => {
    const { container } = render(
      <form>
        <Input label="Name" required helperText="Your public handle" />
        <Input label="Email" error="Enter a valid email" />
      </form>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
