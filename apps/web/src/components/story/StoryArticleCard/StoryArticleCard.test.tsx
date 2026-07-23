// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The story page's article card: headline + notice + media + summary as one
// surface, and — for a LINK story — one stretched control that opens the
// in-app reader. A native post renders the same card with nothing pressable.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { StoryArticleCard } from './StoryArticleCard.js';

const base = {
  title: 'Regional water board publishes the full testing dataset',
  bodySummary: 'The board released raw and processed results alongside the methodology.',
  source: 'Public Records Office',
};

describe('StoryArticleCard', () => {
  it('renders the headline as the page <h1>, with the summary and the source', () => {
    render(<StoryArticleCard {...base} />);
    expect(screen.getByRole('heading', { level: 1, name: base.title })).toBeInTheDocument();
    expect(screen.getByText(base.bodySummary)).toBeInTheDocument();
    expect(screen.getByText(base.source)).toBeInTheDocument();
  });

  it('a LINK story: the whole card is one control that opens the source', async () => {
    const onOpenSource = vi.fn();
    render(
      <StoryArticleCard
        {...base}
        url="https://example.org/water/testing-dataset"
        onOpenSource={onOpenSource}
      />,
    );
    // ONE control — the card itself — named for what it does, not "click here".
    const card = screen.getByRole('button', { name: `Read the source for ${base.title}` });
    await userEvent.click(card);
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    // …and the card SAYS where it goes rather than leaving the reader to guess
    // that the surface is pressable.
    expect(screen.getByText('Read source')).toBeInTheDocument();
    expect(screen.getByText(/example\.org\/water\/testing-dataset/)).toBeInTheDocument();
  });

  it('is operable from the keyboard (a real control, never a click-handler div)', async () => {
    const onOpenSource = vi.fn();
    render(<StoryArticleCard {...base} url="https://example.org/x" onOpenSource={onOpenSource} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /^Read the source for/ })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onOpenSource).toHaveBeenCalledTimes(1);
  });

  it('a NATIVE post is not pressable — nothing pretends to open', () => {
    render(
      <StoryArticleCard
        {...base}
        media={{ url: '/v1/media/abc', kind: 'image', altText: 'A chart of the readings' }}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Read source')).not.toBeInTheDocument();
    expect(screen.getByAltText('A chart of the readings')).toBeInTheDocument();
  });

  it('keeps a video ABOVE the overlay so its controls stay operable on a link story', () => {
    const { container } = render(
      <StoryArticleCard
        {...base}
        url="https://example.org/x"
        onOpenSource={vi.fn()}
        media={{ url: '/v1/media/vid', kind: 'video', altText: null }}
      />,
    );
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    // The media layer is raised out of the overlay's stacking order; without
    // this the transparent overlay would swallow every play/scrub click.
    expect(video?.closest('div.z-10')).not.toBeNull();
  });

  it('does not print the address twice when the source IS the link', () => {
    // Ingestion falls back to the canonical URL as `source` when a submission
    // carries no publisher.
    const url = 'https://example.org/elections/precinct-turnout';
    render(<StoryArticleCard {...base} source={url} url={url} onOpenSource={vi.fn()} />);
    const line = screen.getByText(/example\.org\/elections\/precinct-turnout/);
    expect(line.textContent).toBe('example.org/elections/precinct-turnout');
  });

  it('renders a posture notice under the headline', () => {
    render(<StoryArticleCard {...base} notice={<p>Challenged — a debate is live.</p>} />);
    expect(screen.getByText('Challenged — a debate is live.')).toBeInTheDocument();
  });

  it('passes the accessibility audit in both presentations', async () => {
    const pressable = render(
      <StoryArticleCard {...base} url="https://example.org/x" onOpenSource={vi.fn()} />,
    );
    expect(await checkA11y(pressable.container)).toHaveNoViolations();
    pressable.unmount();

    const plain = render(<StoryArticleCard {...base} />);
    expect(await checkA11y(plain.container)).toHaveNoViolations();
  });
});
