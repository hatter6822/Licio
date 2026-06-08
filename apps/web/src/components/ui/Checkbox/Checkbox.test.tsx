// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Checkbox } from './Checkbox.js';

describe('Checkbox', () => {
  it('renders a native checkbox associated with a visible label', () => {
    render(<Checkbox label="Subscribe to updates" />);
    const input = screen.getByLabelText('Subscribe to updates');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('type', 'checkbox');
  });

  it('toggles with a click and reports the new state via onCheckedChange', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Accept" onCheckedChange={onCheckedChange} />);
    const input = screen.getByRole('checkbox', { name: 'Accept' });
    expect(input).not.toBeChecked();
    await user.click(input);
    expect(input).toBeChecked();
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    await user.click(input);
    expect(input).not.toBeChecked();
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it('toggles with the Space key (native behaviour)', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Remember me" onCheckedChange={onCheckedChange} />);
    const input = screen.getByRole('checkbox', { name: 'Remember me' });
    input.focus();
    expect(input).toHaveFocus();
    await user.keyboard(' ');
    expect(input).toBeChecked();
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
  });

  it('clicking the label text toggles the box (label/control association)', async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Click my label" />);
    const input = screen.getByRole('checkbox', { name: 'Click my label' });
    await user.click(screen.getByText('Click my label'));
    expect(input).toBeChecked();
  });

  it('supports a controlled checked value', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <Checkbox label="Controlled" checked={false} onCheckedChange={onCheckedChange} />,
    );
    const input = screen.getByRole('checkbox', { name: 'Controlled' });
    expect(input).not.toBeChecked();
    await user.click(input);
    // Controlled: stays unchecked until the parent updates the prop.
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(input).not.toBeChecked();
    rerender(<Checkbox label="Controlled" checked onCheckedChange={onCheckedChange} />);
    expect(input).toBeChecked();
  });

  it('honours defaultChecked for uncontrolled usage', () => {
    render(<Checkbox label="Default on" defaultChecked />);
    expect(screen.getByRole('checkbox', { name: 'Default on' })).toBeChecked();
  });

  it('exposes the indeterminate DOM property and aria-checked="mixed"', () => {
    render(<Checkbox label="Select all" indeterminate />);
    const input = screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement;
    expect(input.indeterminate).toBe(true);
    expect(input).toHaveAttribute('aria-checked', 'mixed');
    // The minus indicator is shown for the mixed state.
    expect(input.parentElement?.querySelector('svg')).toBeInTheDocument();
  });

  it('clears the indeterminate DOM property when the prop is removed', () => {
    const { rerender } = render(<Checkbox label="Tri" indeterminate />);
    const input = screen.getByRole('checkbox', { name: 'Tri' }) as HTMLInputElement;
    expect(input.indeterminate).toBe(true);
    rerender(<Checkbox label="Tri" />);
    expect(input.indeterminate).toBe(false);
    expect(input).not.toHaveAttribute('aria-checked', 'mixed');
  });

  it('marks required with aria-required and a visible indicator', () => {
    render(<Checkbox label="Agree to terms" required />);
    const input = screen.getByRole('checkbox', { name: /Agree to terms/ });
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toBeRequired();
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });

  it('links an error via aria-describedby and sets aria-invalid', () => {
    render(<Checkbox label="Consent" error="You must consent to continue" />);
    const input = screen.getByRole('checkbox', { name: 'Consent' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      'You must consent to continue',
    );
  });

  it('does not toggle when disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Off" disabled onCheckedChange={onCheckedChange} />);
    const input = screen.getByRole('checkbox', { name: 'Off' });
    expect(input).toBeDisabled();
    await user.click(input);
    expect(input).not.toBeChecked();
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('keeps a 48px minimum touch target on the label', () => {
    render(<Checkbox label="Touchable" />);
    const input = screen.getByRole('checkbox', { name: 'Touchable' });
    const label = input.closest('label');
    expect(label).toHaveClass('min-h-touch');
  });

  it('has no axe violations across states', async () => {
    const { container } = render(
      <form>
        <Checkbox label="Default" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Mixed" indeterminate />
        <Checkbox label="Required" required />
        <Checkbox label="Errored" error="Required field" />
      </form>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
