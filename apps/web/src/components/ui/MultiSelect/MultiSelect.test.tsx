// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { MultiSelect, type MultiSelectOption, type MultiSelectProps } from './MultiSelect.js';

const options: MultiSelectOption[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'apricot', label: 'Apricot' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

// MultiSelect is fully controlled; a small stateful harness holds the selection
// so a click/keystroke is reflected back into `value` (and an optional spy sees
// each emitted array).
function Harness({
  initial = [],
  onChange,
  label = 'Topics',
  searchLabel = 'Search topics',
  ...props
}: Partial<Omit<MultiSelectProps, 'label' | 'options' | 'value' | 'onChange'>> & {
  initial?: string[];
  onChange?: (values: string[]) => void;
  label?: string;
}) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <MultiSelect
      label={label}
      searchLabel={searchLabel}
      options={options}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      {...props}
    />
  );
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: 'Topics' });
const searchbox = (): HTMLElement => screen.getByRole('combobox', { name: 'Search topics' });
const activeLabel = (): string | null | undefined => {
  const id = searchbox().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : undefined;
};

describe('MultiSelect (searchable)', () => {
  it('renders a labelled trigger button (not a native select) with the Select look', () => {
    render(<Harness />);
    const t = trigger();
    expect(t.tagName).toBe('BUTTON');
    expect(t).toHaveAttribute('aria-haspopup', 'listbox');
    expect(t).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('select')).toBeNull();
    // Same dropdown styling as Select (shared SSOT) so the two look identical.
    expect(t).toHaveClass('bg-canvas', 'neu-raised-sm', 'min-h-touch');
  });

  it('shows a placeholder when empty and a count summary once selected', () => {
    const { rerender } = render(
      <MultiSelect
        label="Topics"
        options={options}
        value={[]}
        onChange={() => {}}
        placeholder="Choose topics"
        max={3}
        summaryLabel={(n, m) => `${n} of ${m} selected`}
      />,
    );
    expect(trigger()).toHaveTextContent('Choose topics');
    rerender(
      <MultiSelect
        label="Topics"
        options={options}
        value={['apple', 'banana']}
        onChange={() => {}}
        placeholder="Choose topics"
        max={3}
        summaryLabel={(n, m) => `${n} of ${m} selected`}
      />,
    );
    expect(trigger()).toHaveTextContent('2 of 3 selected');
  });

  it('opens on click into a search combobox + multi-selectable listbox, focusing search', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const search = searchbox();
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-autocomplete', 'list');
    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveAttribute('aria-multiselectable', 'true');
    expect(within(listbox).getAllByRole('option')).toHaveLength(options.length);
  });

  it('closes when the trigger is clicked again (toggle-close)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(trigger());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens with Enter, Space, and ArrowDown from the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    trigger().focus();
    await user.keyboard(' ');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('filters the listbox by the typed query', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.type(searchbox(), 'ap');
    const shown = screen.getAllByRole('option').map((o) => o.textContent);
    expect(shown).toEqual(['Apple', 'Apricot']);
    await user.clear(searchbox());
    await user.type(searchbox(), 'ban');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Banana']);
  });

  it('re-homes the active option to the first match when the query excludes it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard('{ArrowDown}'); // active = Apricot
    await user.keyboard('{ArrowDown}'); // active = Banana
    await user.type(searchbox(), 'ch'); // filters to [Cherry]; active resets to it
    expect(activeLabel()).toBe('Cherry');
    await user.keyboard('{Enter}'); // Enter-after-filter toggles the first match
    expect(onChange).toHaveBeenLastCalledWith(['cherry']);
  });

  it('shows a no-results status when the query matches nothing (listbox kept empty)', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness noResultsLabel="Nothing found" />);
    await user.click(trigger());
    await user.type(searchbox(), 'zzz');
    // The listbox stays present (so the combobox's aria-controls target is valid)
    // but empty; the no-match copy is a sibling status region.
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('moves option focus with ArrowDown/ArrowUp via aria-activedescendant (wrapping)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    expect(activeLabel()).toBe('Apple'); // active = first on open
    await user.keyboard('{ArrowDown}');
    expect(activeLabel()).toBe('Apricot');
    await user.keyboard('{ArrowUp}');
    expect(activeLabel()).toBe('Apple');
    await user.keyboard('{ArrowUp}'); // wraps to last
    expect(activeLabel()).toBe('Cherry');
    await user.keyboard('{Home}');
    expect(activeLabel()).toBe('Apple');
    await user.keyboard('{End}');
    expect(activeLabel()).toBe('Cherry');
  });

  it('toggles the active option with Enter and KEEPS the popup open (multi-select)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard('{ArrowDown}'); // Apricot
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['apricot']);
    expect(screen.getByRole('listbox')).toBeInTheDocument(); // stays open
    expect(screen.getByRole('option', { name: 'Apricot' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Remove Apricot' })).toBeInTheDocument();
  });

  it('selects several options by mouse in selection order (not catalog order)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    // Pick Cherry then Apple — reverse catalog order, so a catalog-ordered render
    // would fail this assertion.
    await user.click(screen.getByRole('option', { name: 'Cherry' }));
    await user.click(screen.getByRole('option', { name: 'Apple' }));
    const chips = screen.getAllByRole('button', { name: /^Remove / });
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Remove Cherry',
      'Remove Apple',
    ]);
  });

  it('removes a chip via its button and re-homes focus to the adjacent chip', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={['apple', 'banana']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Remove Apple' }));
    expect(onChange).toHaveBeenLastCalledWith(['banana']);
    expect(screen.queryByRole('button', { name: 'Remove Apple' })).not.toBeInTheDocument();
    // Focus is re-homed to the chip that shifted into the removed slot (Banana),
    // never dropped to <body>.
    expect(screen.getByRole('button', { name: 'Remove Banana' })).toHaveFocus();
  });

  it('re-homes focus to the trigger when the last chip is removed', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['apple']} />);
    await user.click(screen.getByRole('button', { name: 'Remove Apple' }));
    expect(trigger()).toHaveFocus();
  });

  it('groups the selection chips in a labelled list region', () => {
    render(<Harness initial={['apple', 'banana']} selectionsLabel="Chosen fruit" />);
    const list = screen.getByRole('list', { name: 'Chosen fruit' });
    expect(within(list).getByRole('button', { name: 'Remove Apple' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Remove Banana' })).toBeInTheDocument();
  });

  it('removes the last chip with Backspace on an empty query (focus stays in search)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={['apple', 'banana']} onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard('{Backspace}');
    expect(onChange).toHaveBeenLastCalledWith(['apple']);
    expect(searchbox()).toHaveFocus();
  });

  it('enforces max: unselected options disable at the cap, selected stay removable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={['apple', 'banana']}
        max={2}
        capNote="Remove one to add another."
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Remove one to add another.')).toBeInTheDocument();
    await user.click(trigger());
    const cherry = screen.getByRole('option', { name: 'Cherry' });
    expect(cherry).toHaveAttribute('aria-disabled', 'true');
    await user.click(cherry);
    expect(onChange).not.toHaveBeenCalled();
    // A selected option can still be toggled off from the list.
    const apple = screen.getByRole('option', { name: 'Apple' });
    expect(apple).not.toHaveAttribute('aria-disabled');
    await user.click(apple);
    expect(onChange).toHaveBeenLastCalledWith(['banana']);
  });

  it('accepts adds up to exactly max, then blocks the next (cap boundary transition)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness max={2} onChange={onChange} />);
    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: 'Apple' }));
    await user.click(screen.getByRole('option', { name: 'Banana' }));
    expect(onChange).toHaveBeenLastCalledWith(['apple', 'banana']);
    // Now at the cap: the third option disables and a click is a no-op.
    const cherry = screen.getByRole('option', { name: 'Cherry' });
    expect(cherry).toHaveAttribute('aria-disabled', 'true');
    onChange.mockClear();
    await user.click(cherry);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not toggle a disabled (over-cap) option via the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={['apple']} max={1} onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard('{End}'); // Cherry (unselected, over cap)
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the trigger without changing the value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on Tab and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes when clicking outside the component', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button">Outside</button>
      </div>,
    );
    await user.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks required with a visible indicator and aria-required on the search combobox', async () => {
    const user = userEvent.setup();
    render(<Harness required />);
    // aria-required is invalid on a button role; the "*" conveys it when closed.
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
    await user.click(trigger());
    expect(searchbox()).toHaveAttribute('aria-required', 'true');
  });

  it('links an error via aria-describedby (trigger) and aria-invalid (search combobox)', async () => {
    const user = userEvent.setup();
    render(<Harness error="Choose a topic" />);
    const t = trigger();
    const describedBy = t.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent('Choose a topic');
    await user.click(t);
    expect(searchbox()).toHaveAttribute('aria-invalid', 'true');
  });

  it('links helper text and keeps both helper and error in aria-describedby', () => {
    render(<Harness helperText="Pick a few" error="Required" />);
    const ids = (trigger().getAttribute('aria-describedby') ?? '').split(' ');
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain('Pick a few');
    expect(texts.some((text) => text?.includes('Required'))).toBe(true);
  });

  it('keeps the label for assistive tech even when visually hidden', () => {
    render(<Harness hideLabel />);
    const labelledBy = trigger().getAttribute('aria-labelledby');
    expect(document.getElementById(labelledBy as string)).toHaveClass('sr-only');
  });

  it('does not open when disabled and disables the chip remove controls', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['apple']} disabled />);
    expect(trigger()).toBeDisabled();
    await user.click(trigger());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Apple' })).toBeDisabled();
  });

  it('has no axe violations when closed, when open, and with selections + an error', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <form>
        <Harness
          label="Fruit"
          searchLabel="Search fruit"
          initial={['apple']}
          required
          max={3}
          helperText="Pick a few"
          capNote="Remove one to add another."
          summaryLabel={(n, m) => `${n} of ${m} selected`}
        />
        <Harness label="Errored" searchLabel="Search errored" error="Required" />
      </form>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Fruit' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
