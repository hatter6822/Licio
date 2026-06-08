// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import type { StoryCardData } from '../types.js';
import { StoryCard } from './StoryCard.js';

const sample: StoryCardData = {
  story: {
    id: 's1',
    title: 'River levels stabilize after upstream coordination',
    source: 'Delta Observer',
    origin: 'independent',
    url: 'https://example.org/story',
    readingMinutes: 4,
  },
  ratingLabel: 'well-sourced',
  distributionReason: 'Rising from independent source opens and evidence additions',
  contextChips: [
    { id: 'c1', label: '3 lenses' },
    { id: 'c2', label: '2 primary sources' },
    { id: 'c3', label: 'low coordination risk' },
  ],
  branchPreview: [
    { id: 'b1', title: 'What changed upstream?' },
    { id: 'b2', title: 'Evidence: gauge readings' },
  ],
};

describe('StoryCard layout (WS-B.2.1a)', () => {
  it('renders every documented field inside an <article> with an accessible name', () => {
    const { container } = render(<StoryCard {...sample} />);
    const article = container.querySelector('article');
    expect(article).toHaveAccessibleName(sample.story.title);

    const heading = screen.getByRole('heading', { level: 3, name: sample.story.title });
    expect(within(heading).getByRole('link')).toHaveAttribute('href', sample.story.url);

    expect(screen.getByText('Delta Observer')).toBeInTheDocument();
    expect(screen.getByText('Independent')).toBeInTheDocument();
    expect(screen.getByText('Well-Sourced')).toBeInTheDocument();
    expect(screen.getByText(sample.distributionReason)).toBeInTheDocument();
    expect(screen.getByText('3 lenses')).toBeInTheDocument();
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
        origin: 'wire',
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
      screen.getByText('Well-Sourced'),
      screen.getByText(sample.distributionReason),
      screen.getByText('3 lenses'),
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
    const preview = screen.getByText('Evidence: gauge readings');
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
