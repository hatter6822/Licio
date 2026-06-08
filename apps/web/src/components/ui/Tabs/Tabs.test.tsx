// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { type TabDescriptor, Tabs } from './Tabs.js';

const tabs: TabDescriptor[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'questions', label: 'Questions' },
  { id: 'evidence', label: 'Evidence' },
];

function renderTabs(props: Partial<React.ComponentProps<typeof Tabs>> = {}) {
  return render(
    <Tabs tabs={tabs} label="Thread branches" {...props}>
      {(active) => <div data-testid="panel">Panel: {active}</div>}
    </Tabs>,
  );
}

describe('Tabs', () => {
  it('implements the tablist/tab/tabpanel roles with the first tab selected by default', () => {
    renderTabs();
    expect(screen.getByRole('tablist', { name: 'Thread branches' })).toBeInTheDocument();
    const tablist = screen.getAllByRole('tab');
    expect(tablist).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby');
    expect(panel).toHaveTextContent('Panel: overview');
  });

  it('uses roving tabindex: exactly one tab is in the tab order', () => {
    renderTabs();
    const allTabs = screen.getAllByRole('tab');
    const tabbable = allTabs.filter((t) => t.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName('Overview');
  });

  it('navigates with arrow keys and Home/End, selecting automatically', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderTabs({ onValueChange });
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Questions' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Questions' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveFocus();
    await user.keyboard('{ArrowRight}'); // wraps to first
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
    expect(onValueChange).toHaveBeenCalled();
  });

  it('manual activation moves focus with arrows but selects only on Enter/Space', async () => {
    const user = userEvent.setup();
    renderTabs({ activationMode: 'manual' });
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Questions' })).toHaveFocus();
    // Not selected yet (manual).
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'Questions' })).toHaveAttribute('aria-selected', 'true');
  });

  it('selects on click and renders the matching panel', async () => {
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel: evidence');
  });

  it('has no axe violations', async () => {
    const { container } = renderTabs();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
