// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { SignalLedger, type SignalLedgerItem } from './SignalLedger.js';

const FIRST_TITLE = 'River levels stabilize after upstream coordination';
const SECOND_TITLE = 'Council publishes the budget evidence pack';
const items: SignalLedgerItem[] = [
  {
    id: 'a',
    title: FIRST_TITLE,
    signals: ['active_dwell', 'source_opened', 'context_opened'],
  },
  {
    id: 'b',
    title: SECOND_TITLE,
    signals: ['contribution_created', 'return_visit'],
    capReached: true,
  },
];

describe('SignalLedger (WS-B.2.6)', () => {
  it('renders a private, read-only panel with a heading and a privacy note', () => {
    render(<SignalLedger items={items} />);
    const panel = screen.getByRole('heading', { level: 2, name: /signal ledger/i });
    expect(panel).toBeInTheDocument();
    // The description states plainly that it is private and shows no score/rank.
    expect(screen.getByText(/only you can see this/i)).toBeInTheDocument();
    // Read-only: the panel contains no interactive controls.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('maps each signal kind to its exact human-readable phrasing', () => {
    render(<SignalLedger items={items} />);
    expect(screen.getByText('You spent active reading time')).toBeInTheDocument();
    expect(screen.getByText('You opened the source')).toBeInTheDocument();
    expect(screen.getByText('You opened context')).toBeInTheDocument();
    expect(screen.getByText('You contributed')).toBeInTheDocument();
    expect(screen.getByText('You returned to follow up')).toBeInTheDocument();
  });

  it('explains when per-item counting stopped (cap reached)', () => {
    render(<SignalLedger items={items} />);
    expect(screen.getByText('Counting stopped (per-item limit reached)')).toBeInTheDocument();
  });

  it('uses semantic headings and nested lists per item', () => {
    render(<SignalLedger items={items} />);
    // Each item is a sub-heading under the panel heading.
    expect(screen.getByRole('heading', { level: 3, name: FIRST_TITLE })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: SECOND_TITLE })).toBeInTheDocument();

    // The signals for an item form a list, each phrasing its own list item.
    const itemHeading = screen.getByRole('heading', { level: 3, name: FIRST_TITLE });
    const itemRegion = itemHeading.closest('li');
    expect(itemRegion).not.toBeNull();
    const list = within(itemRegion as HTMLElement).getByRole('list');
    expect(within(list).getAllByRole('listitem').length).toBe(3);
  });

  it('respects the requested heading level', () => {
    render(<SignalLedger items={items} headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: /signal ledger/i })).toBeInTheDocument();
    // Item titles step down to <h4> so the hierarchy stays well-formed.
    expect(screen.getByRole('heading', { level: 4, name: FIRST_TITLE })).toBeInTheDocument();
  });

  it('NEVER renders a public score, rank, or raw numeric signal value', () => {
    const { container } = render(<SignalLedger items={items} />);
    // Item titles in this fixture are digit-free, so any digit in the rendered
    // text would necessarily be a leaked count/score/rank/weight.
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d/);

    // Scan only the activity entries (not the panel's explanatory prose, which is
    // allowed to *say* it shows no score/rank): no applause-style tokens leak in
    // the per-item signal phrasings.
    const lists = container.querySelectorAll('li');
    const entryText = Array.from(lists)
      .map((node) => node.textContent ?? '')
      .join(' ');
    expect(entryText).not.toMatch(/\b(?:points?|pts?|score|rank(?:ed)?|votes?)\b/i);
    expect(entryText).not.toContain('+1');
    expect(entryText).not.toContain('%');
  });

  it('renders an empty state with no leaked figures when there is no activity', () => {
    const { container } = render(<SignalLedger items={[]} />);
    expect(screen.getByText('No activity recorded yet.')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/\d/);
  });

  it('has no axe violations', async () => {
    const { container } = render(<SignalLedger items={items} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
