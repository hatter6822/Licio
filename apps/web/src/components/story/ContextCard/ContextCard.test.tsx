// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../i18n/index.js';
import { checkA11y } from '../../../test/axe.js';
import { ContextCard } from './ContextCard.js';
import type { ContextCardData } from './types.js';

function makeData(overrides: Partial<ContextCardData> = {}): ContextCardData {
  return {
    whatHappened: 'Upstream operators coordinated a controlled release.',
    whyItMatters: 'Downstream communities had hours, not minutes, to prepare.',
    interpretations: [
      { perspective: 'Hydrologists', summary: 'The model held within tolerance.' },
      { perspective: 'Local residents', summary: 'Warnings still arrived unevenly.' },
    ],
    evidenceStatus: 'Two primary gauge datasets; one awaiting confirmation.',
    conversationState: { ratingLabel: 'well-sourced', detail: 'Most claims are sourced.' },
    distributionReason: 'Surfaced because independent sources opened and added evidence.',
    onSeeLess: vi.fn(),
    onSeeMore: vi.fn(),
    onMuteTopic: vi.fn(),
    onInspectSignals: vi.fn(),
    onReport: vi.fn(),
    ...overrides,
  };
}

const EXPECTED_HEADINGS = [
  'What happened',
  'Why it matters',
  'Where interpretations differ',
  'Evidence status',
  'Conversation state',
  'Distribution reason',
  'Your controls',
];

describe('ContextCard layout (WS-B.2.4a)', () => {
  it('renders all seven sections, with <h2> headings, in the documented order', () => {
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);

    // The Sheet's own title is an <h2>; the seven section headings are the
    // level-2 headings that follow it. Filter to our section headings by name.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim());

    for (const expected of EXPECTED_HEADINGS) {
      expect(headings).toContain(expected);
    }

    // Order: each expected heading precedes the next in the DOM.
    const nodes = EXPECTED_HEADINGS.map((name) => screen.getByRole('heading', { level: 2, name }));
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const pos = nodes[i]?.compareDocumentPosition(nodes[i + 1] as Node);
      expect(pos && pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('renders each section inside a labelled region', () => {
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);
    for (const name of EXPECTED_HEADINGS) {
      // getByRole('region', { name }) confirms the <section aria-labelledby> wiring.
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('surfaces the conversation state as a RatingLabel (state, not a score)', () => {
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);
    const region = screen.getByRole('region', { name: 'Conversation state' });
    expect(within(region).getByText('Well-Sourced')).toBeInTheDocument();
  });

  it('shows the human-readable distribution reason verbatim', () => {
    const data = makeData();
    render(<ContextCard open onClose={() => undefined} data={data} />);
    const region = screen.getByRole('region', { name: 'Distribution reason' });
    expect(within(region).getByText(data.distributionReason as string)).toBeInTheDocument();
  });

  it('renders the multiple community perspectives', () => {
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);
    const region = screen.getByRole('region', { name: 'Where interpretations differ' });
    expect(within(region).getByText('Hydrologists')).toBeInTheDocument();
    expect(within(region).getByText('Local residents')).toBeInTheDocument();
  });

  it('does not render closed (open by default) — bodies are visible immediately', () => {
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);
    for (const details of document.querySelectorAll('details')) {
      expect(details).toHaveAttribute('open');
    }
  });
});

describe('ContextCard collapsible behaviour (WS-B.2.4b)', () => {
  it('a section collapses and re-expands via its native summary', async () => {
    const user = userEvent.setup();
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);

    // The summary's accessible name is the section heading text.
    const summary = screen.getByText('What happened').closest('summary');
    expect(summary).not.toBeNull();
    const details = summary?.closest('details');
    expect(details).toHaveAttribute('open');

    await user.click(summary as HTMLElement);
    expect(details).not.toHaveAttribute('open');

    await user.click(summary as HTMLElement);
    expect(details).toHaveAttribute('open');
  });
});

describe('ContextCard user controls (WS-B.2.4b, no-applause)', () => {
  it('wires every control callback, including report (never a downvote)', async () => {
    const user = userEvent.setup();
    const data = makeData();
    render(<ContextCard open onClose={() => undefined} data={data} />);

    await user.click(screen.getByRole('button', { name: 'See less' }));
    await user.click(screen.getByRole('button', { name: 'See more' }));
    await user.click(screen.getByRole('button', { name: 'Mute topic' }));
    await user.click(screen.getByRole('button', { name: 'Inspect ranking signals' }));
    await user.click(screen.getByRole('button', { name: 'Signal problem' }));

    expect(data.onSeeLess).toHaveBeenCalledTimes(1);
    expect(data.onSeeMore).toHaveBeenCalledTimes(1);
    expect(data.onMuteTopic).toHaveBeenCalledTimes(1);
    expect(data.onInspectSignals).toHaveBeenCalledTimes(1);
    expect(data.onReport).toHaveBeenCalledTimes(1);
  });

  it('omits controls whose callbacks are not provided', () => {
    // Only onSeeLess is supplied; the other control callbacks are absent, so
    // their buttons must not render.
    const data: ContextCardData = {
      whatHappened: 'Upstream operators coordinated a controlled release.',
      whyItMatters: 'Downstream communities had hours to prepare.',
      interpretations: [{ perspective: 'Hydrologists', summary: 'Within tolerance.' }],
      evidenceStatus: 'Two primary gauge datasets.',
      conversationState: { detail: 'Most claims are sourced.' },
      distributionReason: 'Surfaced because independent sources opened.',
      onSeeLess: () => undefined,
    };
    render(<ContextCard open onClose={() => undefined} data={data} />);
    expect(screen.getByRole('button', { name: 'See less' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mute topic' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Signal problem' })).toBeNull();
  });

  it('exposes NO applause affordance (no like / vote / upvote / score control)', () => {
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);
    for (const re of [/like/i, /upvote/i, /downvote/i, /\bvote\b/i, /score/i, /applau/i]) {
      expect(screen.queryByRole('button', { name: re })).toBeNull();
    }
  });
});

describe('ContextCard section navigation (non-swipe, WCAG 2.5.1)', () => {
  it('moves focus between section headings via the prev/next pager', async () => {
    const user = userEvent.setup();
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);

    // From the first section, "Next" should focus the second section's heading.
    const firstRegion = screen.getByRole('region', { name: 'What happened' });
    const nextButtons = within(firstRegion).getAllByRole('button', { name: 'Next section' });
    await user.click(nextButtons[0] as HTMLElement);

    expect(screen.getByRole('heading', { level: 2, name: 'Why it matters' })).toHaveFocus();
  });

  it('jumps to the last section from the top navigator', async () => {
    const user = userEvent.setup();
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);
    await user.click(screen.getByRole('button', { name: 'Go to the last section' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Your controls' })).toHaveFocus();
  });
});

describe('ContextCard dismissal + i18n + a11y', () => {
  it('closes via the Sheet (Escape and the Close button both call onClose)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ContextCard open onClose={onClose} data={makeData()} />);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when closed', () => {
    render(<ContextCard open={false} onClose={() => undefined} data={makeData()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'What happened' })).toBeNull();
  });

  it('routes section copy through the localization layer', () => {
    render(
      <I18nProvider
        locale="es"
        messages={{ 'context.whatHappened': 'Qué pasó', 'context.report': 'Señalar problema' }}
      >
        <ContextCard open onClose={() => undefined} data={makeData()} />
      </I18nProvider>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Qué pasó' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Señalar problema' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    render(<ContextCard open onClose={() => undefined} data={makeData()} />);
    const dialog = screen.getByRole('dialog');
    expect(await checkA11y(dialog)).toHaveNoViolations();
  });
});
