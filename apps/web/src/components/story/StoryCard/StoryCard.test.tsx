// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import type { StoryCardData } from '../types.js';
import { StoryCard } from './StoryCard.js';

const sample: StoryCardData = {
  story: {
    id: 's1',
    title: 'River levels stabilize after upstream coordination',
    source: 'Delta Observer',
    url: 'https://example.org/story',
    readingMinutes: 4,
  },
  ratingLabel: 'deepening',
  distributionReason: 'Rising from independent source opens and sourced comments',
  contextChips: [
    { id: 'c1', label: '3 sourced comments' },
    { id: 'c2', label: '2 primary sources' },
    { id: 'c3', label: 'low coordination risk' },
  ],
  branchPreview: [
    { id: 'b1', title: 'What changed upstream?' },
    { id: 'b2', title: 'Sources: gauge readings' },
  ],
};

describe('StoryCard layout (WS-B.2.1a)', () => {
  it('renders every documented field inside an <article> with an accessible name', () => {
    const { container } = render(<StoryCard {...sample} />);
    const article = container.querySelector('article');
    expect(article).toHaveAccessibleName(sample.story.title);

    // The title is plain heading text — feed navigation is the wrapper's job
    // (StoryFeedLink), so the card never nests an <a> inside the route link.
    const heading = screen.getByRole('heading', { level: 3, name: sample.story.title });
    expect(within(heading).queryByRole('link')).toBeNull();

    expect(screen.getByText('Delta Observer')).toBeInTheDocument();
    expect(screen.getByText('Deepening')).toBeInTheDocument();
    expect(screen.getByText(sample.distributionReason)).toBeInTheDocument();
    expect(screen.getByText('3 sourced comments')).toBeInTheDocument();
    expect(screen.getByText('4 min read')).toBeInTheDocument();
    expect(screen.getByText('What changed upstream?')).toBeInTheDocument();
  });

  it('respects the requested heading level for hierarchy', () => {
    render(<StoryCard {...sample} headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2, name: sample.story.title })).toBeInTheDocument();
  });

  it('renders with minimal fields (no chips, no branch preview)', () => {
    const minimal: StoryCardData = {
      story: {
        id: 's2',
        title: 'Quiet update',
        source: 'Wire Co',
        readingMinutes: 1,
      },
      ratingLabel: 'getting-attention',
      distributionReason: 'New from a wire source',
    };
    render(<StoryCard {...minimal} />);
    expect(screen.getByRole('heading', { name: 'Quiet update' })).toBeInTheDocument();
    expect(screen.queryByText('lenses')).toBeNull();
    expect(screen.getByText('1 min read')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <StoryCard {...sample} onSave={() => undefined} onOpenContext={() => undefined} />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('StoryCard screen-reader order (WS-B.2.1c / WCAG 1.3.2)', () => {
  it('places content in DOM order: title → source → rating → reason → chips → estimate → preview', () => {
    render(<StoryCard {...sample} />);
    const ordered = [
      screen.getByText(sample.story.title),
      screen.getByText('Delta Observer'),
      screen.getByText('Deepening'),
      screen.getByText(sample.distributionReason),
      screen.getByText('3 sourced comments'),
      screen.getByText('4 min read'),
      screen.getByText('What changed upstream?'),
    ];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const position = ordered[i]?.compareDocumentPosition(ordered[i + 1] as Node);
      // Each element precedes the next in document order.
      expect(position && position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('interactive actions come after the content in the DOM', () => {
    render(<StoryCard {...sample} onSave={() => undefined} />);
    const preview = screen.getByText('Sources: gauge readings');
    const saveButton = screen.getByRole('button', { name: /Save/ });
    expect(
      preview.compareDocumentPosition(saveButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('does not reorder content with CSS (no row-reverse / order utilities)', () => {
    const { container } = render(<StoryCard {...sample} />);
    const html = container.innerHTML;
    expect(html).not.toContain('flex-row-reverse');
    expect(html).not.toMatch(/\border-\d/);
  });
});

describe('StoryCard distribution-reason guard (no-applause)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns in development when the distribution reason looks like a raw score', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<StoryCard {...sample} distributionReason="Ranked 87 points this hour" />);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not warn for a human-readable distribution reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<StoryCard {...sample} distributionReason="Rising from independent source opens" />);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('origin badge', () => {
  it('renders no source-origin badge (the hardcoded "Independent" placeholder is gone)', () => {
    // The `origin` field was never a real derived signal — the feed and detail
    // reads hardcoded it to 'independent', so the badge claimed every source was
    // "Independent". The field and badge were removed; only the lowercase word
    // inside the distribution reason ("independent source opens") remains.
    render(<StoryCard {...sample} />);
    expect(screen.queryByText('Independent')).not.toBeInTheDocument();
  });

  it('carries no MERI exposure label anywhere on the card', () => {
    render(<StoryCard {...sample} />);
    expect(screen.queryByText('Independent source')).not.toBeInTheDocument();
    expect(screen.queryByText('New angle')).not.toBeInTheDocument();
    expect(screen.queryByText('Duplicate context')).not.toBeInTheDocument();
  });
});

describe('lens-count chip removal', () => {
  it('drops a lens-count chip from ANY producer at the render boundary', () => {
    // Structural enforcement: whatever passes a lens-count chip (feed, styleguide,
    // a stale cached card), the "N lenses" affordance never renders. Match both
    // the `lenses` id and a bare "N lens(es)" label; keep every other chip.
    render(
      <StoryCard
        {...sample}
        contextChips={[
          { id: 'lenses', label: '2 lenses' },
          { id: 'c1', label: '3 lenses' },
          { id: 'c2', label: '1 lens' },
          { id: 'c3', label: '2 primary sources' },
        ]}
      />,
    );
    expect(screen.queryByText('2 lenses')).not.toBeInTheDocument();
    expect(screen.queryByText('3 lenses')).not.toBeInTheDocument();
    expect(screen.queryByText('1 lens')).not.toBeInTheDocument();
    expect(screen.getByText('2 primary sources')).toBeInTheDocument();
  });
});
