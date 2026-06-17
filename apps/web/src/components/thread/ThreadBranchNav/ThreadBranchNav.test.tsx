// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { BRANCH_IDS, ThreadBranchNav, type ThreadBranchNavProps } from './ThreadBranchNav.js';

/** A populated Overview branch with the semantic headings a long branch uses. */
const overviewContent = (
  <div>
    <h3>Best current synthesis</h3>
    <p>River levels stabilized after upstream coordination.</p>
    <h3>Unresolved questions</h3>
    <p>Whether the gauge calibration held overnight.</p>
    <h3>Evidence status</h3>
    <p>Two primary sources corroborated; one pending review.</p>
  </div>
);

function renderNav(props: Partial<ThreadBranchNavProps> = {}) {
  return render(
    <ThreadBranchNav
      branches={{
        overview: { content: overviewContent },
        questions: { content: <p>Open questions list</p> },
        evidence: { content: <p>Evidence ledger</p> },
        challenges: { content: <p>Challenges</p> },
        lenses: { content: <p>Lenses</p> },
        chronology: { content: <p>Chronology</p> },
      }}
      {...props}
    />,
  );
}

describe('ThreadBranchNav (WS-B.2.12)', () => {
  it('renders all six branches as tabs with Overview selected by default', () => {
    renderNav();
    expect(screen.getByRole('tablist', { name: 'Thread branches' })).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    expect(tabs).toHaveLength(BRANCH_IDS.length);

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    // Overview is the landing branch — its panel content is visible immediately.
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Best current synthesis');
  });

  it('honours an explicit defaultBranch', () => {
    renderNav({ defaultBranch: 'evidence' });
    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Evidence ledger');
  });

  it('navigates branches with the arrow keys (provided by Tabs) and fires onBranchChange', async () => {
    const user = userEvent.setup();
    const onBranchChange = vi.fn();
    renderNav({ onBranchChange });

    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');

    const questions = screen.getByRole('tab', { name: 'Questions' });
    expect(questions).toHaveFocus();
    expect(questions).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Open questions list');
    expect(onBranchChange).toHaveBeenCalledWith('questions');
  });

  it('exposes h3 headings for screen-reader heading navigation in a long branch', () => {
    renderNav();
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual([
      'Best current synthesis',
      'Unresolved questions',
      'Evidence status',
    ]);
  });

  it('shows a Skeleton while a branch is loading without an extra role', () => {
    renderNav({ branches: { overview: { loading: true } } });
    const busy = screen.getByTestId('branch-skeleton-overview');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    // The active tab still owns focusability — the skeleton must not be a tabstop.
    expect(within(busy).queryAllByRole('button')).toHaveLength(0);
  });

  it('supports a renderBranch render-prop as an alternative to static branches', () => {
    render(<ThreadBranchNav renderBranch={(id) => <p data-testid="rendered">Branch is {id}</p>} />);
    expect(screen.getByTestId('rendered')).toHaveTextContent('Branch is overview');
  });

  it('renders a labeled, reachable Contribute button that fires its callback', async () => {
    const user = userEvent.setup();
    const onContribute = vi.fn();
    renderNav({ onContribute });

    const contribute = screen.getByRole('button', { name: 'Contribute to this thread' });
    expect(contribute).toBeInTheDocument();
    await user.click(contribute);
    expect(onContribute).toHaveBeenCalledTimes(1);
  });

  it('omits the Contribute button when no handler is provided', () => {
    renderNav();
    expect(screen.queryByRole('button', { name: /contribute/i })).toBeNull();
  });

  it('floats the Contribute CTA centered and clear of the bottom nav via a fixed wrapper', () => {
    renderNav({ onContribute: () => undefined });
    const contribute = screen.getByRole('button', { name: 'Contribute to this thread' });
    // Positioning lives on the WRAPPER, not the Button: the Button base hardcodes
    // `relative`, which (with no tailwind-merge in `cn`) would win a `position`
    // conflict and leave the CTA in flow. The wrapper is a plain, fixed div.
    const wrapper = contribute.parentElement;
    const wrapperClasses = wrapper?.className.split(/\s+/) ?? [];
    expect(wrapperClasses).toEqual(
      expect.arrayContaining(['fixed', 'inset-x-0', 'w-fit', 'mx-auto']),
    );
    expect(wrapper?.className).toContain('bottom-[calc(env(safe-area-inset-bottom)+5rem)]');
    // The Button must carry NO competing position utility (no conflict to lose).
    const buttonClasses = contribute.className.split(/\s+/);
    expect(buttonClasses).not.toContain('fixed');
    expect(buttonClasses).not.toContain('end-4');
    expect(buttonClasses).not.toContain('bottom-4');
  });

  it('has no axe violations', async () => {
    const { container } = renderNav({ onContribute: () => undefined });
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
