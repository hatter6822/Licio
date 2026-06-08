// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { DEFAULT_FEED_MODE, type FeedMode, FeedModeSwitcher } from './FeedModeSwitcher.js';

function Controlled({
  initial = DEFAULT_FEED_MODE,
  onChange,
}: {
  initial?: FeedMode;
  onChange?: (v: FeedMode) => void;
}): React.ReactElement {
  const [value, setValue] = useState<FeedMode>(initial);
  return (
    <FeedModeSwitcher
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe('FeedModeSwitcher (WS-B.2.9)', () => {
  it('defaults to Balanced', () => {
    expect(DEFAULT_FEED_MODE).toBe('balanced');
  });

  it('shows the current mode on the labelled combobox trigger', () => {
    render(<FeedModeSwitcher value="balanced" onValueChange={() => undefined} />);
    const trigger = screen.getByRole('combobox', { name: 'Feed order' });
    expect(trigger).toHaveTextContent('Balanced');
  });

  it('offers all five ordering modes', async () => {
    const user = userEvent.setup();
    render(<FeedModeSwitcher value="balanced" onValueChange={() => undefined} />);
    await user.click(screen.getByRole('combobox', { name: 'Feed order' }));

    const listbox = screen.getByRole('listbox');
    for (const label of [
      'Balanced',
      'Chronological',
      'Source-diverse',
      'Local',
      'Low personalization',
    ]) {
      expect(within(listbox).getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the active mode with aria-selected (the announced current state)', async () => {
    const user = userEvent.setup();
    render(<FeedModeSwitcher value="chronological" onValueChange={() => undefined} />);
    await user.click(screen.getByRole('combobox', { name: 'Feed order' }));
    expect(screen.getByRole('option', { name: 'Chronological' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: 'Balanced' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('emits the chosen mode value and reflects it on the trigger', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Feed order' }));
    await user.click(screen.getByRole('option', { name: 'Source-diverse' }));

    expect(onChange).toHaveBeenCalledWith('source-diverse');
    expect(screen.getByRole('combobox', { name: 'Feed order' })).toHaveTextContent(
      'Source-diverse',
    );
  });

  it('does not render a separate live region (Select announces via aria-selected)', () => {
    const { container } = render(
      <FeedModeSwitcher value="balanced" onValueChange={() => undefined} />,
    );
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Controlled />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
