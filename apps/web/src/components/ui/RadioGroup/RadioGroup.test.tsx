// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { RadioGroup, type RadioOption } from './RadioGroup.js';

const options: RadioOption[] = [
  { value: 'public', label: 'Public' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'private', label: 'Private' },
];

function renderGroup(props: Partial<React.ComponentProps<typeof RadioGroup>> = {}) {
  return render(<RadioGroup label="Visibility" options={options} {...props} />);
}

describe('RadioGroup', () => {
  it('renders a radiogroup labelled by a visible group label with radio children', () => {
    renderGroup();
    const group = screen.getByRole('radiogroup', { name: 'Visibility' });
    expect(group).toBeInTheDocument();
    expect(within(group).getAllByRole('radio')).toHaveLength(options.length);
  });

  it('exposes each option as role="radio" with an accessible name', () => {
    renderGroup();
    for (const option of options) {
      expect(screen.getByRole('radio', { name: option.label })).toBeInTheDocument();
    }
  });

  it('keeps each option at a 48px minimum touch target', () => {
    renderGroup();
    for (const option of options) {
      expect(screen.getByRole('radio', { name: option.label })).toHaveClass('min-h-touch');
    }
  });

  it('has exactly one tab stop: the first option when nothing is selected', () => {
    renderGroup();
    const radios = screen.getAllByRole('radio');
    const tabbable = radios.filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName('Public');
  });

  it('puts the selected option in the tab order (roving tabindex)', () => {
    renderGroup({ defaultValue: 'private' });
    const radios = screen.getAllByRole('radio');
    const tabbable = radios.filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName('Private');
    expect(screen.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'true');
  });

  it('reaches the group with a single Tab from a preceding control', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Before</button>
        <RadioGroup label="Visibility" options={options} />
      </div>,
    );
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    // A single Tab lands on the one tabbable radio (the first option).
    expect(screen.getByRole('radio', { name: 'Public' })).toHaveFocus();
  });

  it('selects with a click and reports the value via onValueChange', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderGroup({ onValueChange });
    await user.click(screen.getByRole('radio', { name: 'Unlisted' }));
    expect(onValueChange).toHaveBeenCalledWith('unlisted');
    expect(screen.getByRole('radio', { name: 'Unlisted' })).toHaveAttribute('aria-checked', 'true');
  });

  it('ArrowDown moves focus and selection to the next option (wrapping)', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderGroup({ onValueChange });
    const first = screen.getByRole('radio', { name: 'Public' });
    first.focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Unlisted' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Unlisted' })).toHaveAttribute('aria-checked', 'true');
    expect(onValueChange).toHaveBeenLastCalledWith('unlisted');

    await user.keyboard('{ArrowDown}'); // Private
    await user.keyboard('{ArrowDown}'); // wraps back to Public
    expect(screen.getByRole('radio', { name: 'Public' })).toHaveFocus();
    expect(onValueChange).toHaveBeenLastCalledWith('public');
  });

  it('ArrowUp moves to the previous option and wraps to the last', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderGroup({ onValueChange });
    const first = screen.getByRole('radio', { name: 'Public' });
    first.focus();
    await user.keyboard('{ArrowUp}'); // wraps to Private
    expect(screen.getByRole('radio', { name: 'Private' })).toHaveFocus();
    expect(onValueChange).toHaveBeenLastCalledWith('private');
  });

  it('ArrowRight/ArrowLeft also move selection (horizontal equivalence)', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderGroup({ onValueChange });
    screen.getByRole('radio', { name: 'Public' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onValueChange).toHaveBeenLastCalledWith('unlisted');
    await user.keyboard('{ArrowLeft}');
    expect(onValueChange).toHaveBeenLastCalledWith('public');
  });

  it('Space selects the focused radio', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderGroup({ onValueChange });
    const radio = screen.getByRole('radio', { name: 'Unlisted' });
    radio.focus();
    await user.keyboard(' ');
    expect(onValueChange).toHaveBeenCalledWith('unlisted');
    expect(radio).toHaveAttribute('aria-checked', 'true');
  });

  it('only the selected radio stays tabbable after navigation', async () => {
    const user = userEvent.setup();
    renderGroup();
    screen.getByRole('radio', { name: 'Public' }).focus();
    await user.keyboard('{ArrowDown}'); // select Unlisted
    const tabbable = screen.getAllByRole('radio').filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName('Unlisted');
  });

  it('supports a controlled value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = render(
      <RadioGroup
        label="Visibility"
        options={options}
        value="public"
        onValueChange={onValueChange}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Public' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Private' }));
    // Controlled: stays on Public until the parent updates the prop.
    expect(onValueChange).toHaveBeenCalledWith('private');
    expect(screen.getByRole('radio', { name: 'Public' })).toHaveAttribute('aria-checked', 'true');
    rerender(
      <RadioGroup
        label="Visibility"
        options={options}
        value="private"
        onValueChange={onValueChange}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'true');
  });

  it('marks required with aria-required and a visible indicator', () => {
    renderGroup({ required: true });
    const group = screen.getByRole('radiogroup', { name: /Visibility/ });
    expect(group).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });

  it('links an error via aria-describedby and sets aria-invalid on the group', () => {
    renderGroup({ error: 'Pick a visibility' });
    const group = screen.getByRole('radiogroup', { name: 'Visibility' });
    expect(group).toHaveAttribute('aria-invalid', 'true');
    const describedBy = group.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent('Pick a visibility');
  });

  it('has no axe violations across states', async () => {
    const { container } = render(
      <form>
        <RadioGroup label="Visibility" options={options} required />
        <RadioGroup label="Sort" options={options} defaultValue="unlisted" />
        <RadioGroup label="Audience" options={options} error="Required" />
      </form>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
