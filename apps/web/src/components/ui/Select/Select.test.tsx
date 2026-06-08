// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Select, type SelectOption } from './Select.js';

const options: SelectOption[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'apricot', label: 'Apricot' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

function renderSelect(props: Partial<React.ComponentProps<typeof Select>> = {}) {
  return render(<Select label="Fruit" options={options} {...props} />);
}

describe('Select', () => {
  it('renders a labelled trigger button (not a native select) with listbox semantics', () => {
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // No native <select> anywhere.
    expect(document.querySelector('select')).toBeNull();
  });

  it('shows the placeholder until a value is chosen', () => {
    renderSelect({ placeholder: 'Pick a fruit' });
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Pick a fruit');
  });

  it('keeps a 48px minimum touch target on the trigger', () => {
    renderSelect();
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveClass('min-h-touch');
  });

  it('opens on click and exposes role="listbox" with role="option" children', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(options.length);
  });

  it('opens with Enter, Space, and ArrowDown', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });

    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.keyboard(' ');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('moves option focus with ArrowDown/ArrowUp via aria-activedescendant', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open, active = first (Apple)

    const activeId = () => trigger.getAttribute('aria-activedescendant');
    const labelOf = (id: string | null) =>
      id ? document.getElementById(id)?.textContent : undefined;

    expect(labelOf(activeId())).toBe('Apple');
    await user.keyboard('{ArrowDown}');
    expect(labelOf(activeId())).toBe('Apricot');
    await user.keyboard('{ArrowUp}');
    expect(labelOf(activeId())).toBe('Apple');
    // Wraps to the last option when arrowing up from the first.
    await user.keyboard('{ArrowUp}');
    expect(labelOf(activeId())).toBe('Cherry');
  });

  it('jumps to first/last with Home/End', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');

    const labelOf = () => {
      const id = trigger.getAttribute('aria-activedescendant');
      return id ? document.getElementById(id)?.textContent : undefined;
    };

    await user.keyboard('{End}');
    expect(labelOf()).toBe('Cherry');
    await user.keyboard('{Home}');
    expect(labelOf()).toBe('Apple');
  });

  it('selects the active option with Enter, closes, and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ onValueChange });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // Apple
    await user.keyboard('{ArrowDown}'); // Apricot
    await user.keyboard('{Enter}');

    expect(onValueChange).toHaveBeenCalledWith('apricot');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent('Apricot');
  });

  it('selects the active option with Space', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ onValueChange });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // Apple
    await user.keyboard(' ');
    expect(onValueChange).toHaveBeenCalledWith('apple');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('selects an option on mouse click and marks it aria-selected', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ onValueChange });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Banana' }));
    expect(onValueChange).toHaveBeenCalledWith('banana');
    expect(trigger).toHaveTextContent('Banana');

    // Reopen and verify the committed option reports aria-selected.
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes on Escape and returns focus to the trigger without changing the value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSelect({ onValueChange });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('type-ahead jumps to the first option whose label starts with a single typed character', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open, active = Apple
    await user.keyboard('b'); // -> Banana
    const id = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(id as string)?.textContent).toBe('Banana');
  });

  it('type-ahead accumulates rapid keystrokes into a multi-character prefix', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open, active = Apple
    // 'a' alone would match Apple; the full 'apr' prefix disambiguates to Apricot.
    await user.keyboard('apr');
    const id = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(id as string)?.textContent).toBe('Apricot');
  });

  it('type-ahead that matches nothing leaves the active option unchanged', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open, active = Apple
    await user.keyboard('z'); // no label starts with 'z'
    const id = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(id as string)?.textContent).toBe('Apple');
  });

  it('opens on ArrowUp with the last option active', async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowUp}');
    const id = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(id as string)?.textContent).toBe('Cherry');
  });

  it('closes when clicking outside the component', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Select label="Fruit" options={options} />
        <button type="button">Outside</button>
      </div>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('supports a controlled value and reflects external updates', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = render(
      <Select label="Fruit" options={options} value="apple" onValueChange={onValueChange} />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toHaveTextContent('Apple');
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Cherry' }));
    // Controlled: value does not change until the parent updates the prop.
    expect(onValueChange).toHaveBeenCalledWith('cherry');
    expect(trigger).toHaveTextContent('Apple');
    rerender(
      <Select label="Fruit" options={options} value="cherry" onValueChange={onValueChange} />,
    );
    expect(trigger).toHaveTextContent('Cherry');
  });

  it('honours defaultValue for uncontrolled usage', () => {
    renderSelect({ defaultValue: 'banana' });
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Banana');
  });

  it('marks required with aria-required and a visible indicator', () => {
    renderSelect({ required: true });
    const trigger = screen.getByRole('combobox', { name: /Fruit/ });
    expect(trigger).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });

  it('links an error via aria-describedby and sets aria-invalid', () => {
    renderSelect({ error: 'Choose a fruit' });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    const describedBy = trigger.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent('Choose a fruit');
  });

  it('links helper text and keeps both helper and error in aria-describedby', () => {
    renderSelect({ helperText: 'Used for filtering', error: 'Required' });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    const ids = (trigger.getAttribute('aria-describedby') ?? '').split(' ');
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain('Used for filtering');
    expect(texts.some((t) => t?.includes('Required'))).toBe(true);
  });

  it('keeps the label for assistive tech even when visually hidden', () => {
    renderSelect({ hideLabel: true });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    const labelledBy = trigger.getAttribute('aria-labelledby');
    expect(document.getElementById(labelledBy as string)).toHaveClass('sr-only');
  });

  it('does not open when disabled', async () => {
    const user = userEvent.setup();
    renderSelect({ disabled: true });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('has no axe violations when closed and when open', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <form>
        <Select label="Fruit" options={options} required helperText="Pick one" />
        <Select label="Errored" options={options} error="Required" />
      </form>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
