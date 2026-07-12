// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Independent-sources drawer (SPEC §7.6; WS-H.2.3a).  Covers the lazy read
// gate (nothing fetched until the sheet opens), the populated sections
// (exposure line, publisher lineage, same-coverage links, steward-reviewed
// primary sources, lineage-grouped claims), and the absence-honest states —
// a story MERI has not covered yet says so and fabricates nothing.
import type { IndependentSourcesResponse } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
    className,
  }: {
    children: ReactNode;
    params?: { storyId?: string };
    className?: string;
  }) => (
    <a href={`/stories/${params?.storyId ?? ''}`} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('../../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api.js')>();
  return {
    ...actual,
    fetchIndependentSources: vi.fn(),
    fetchStoryClaims: vi.fn(),
  };
});

const api = await import('../../../lib/api.js');
const { IndependentSourcesDrawer } = await import('./IndependentSourcesDrawer.js');

function Providers({ children }: { children: ReactNode }): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const NOW = new Date('2026-05-01T00:00:00.000Z').toISOString();
const STORY_ID = '33333333-3333-4333-8333-333333333333';
const CO_STORY_ID = '44444444-4444-4444-8444-444444444444';

const fullResponse: IndependentSourcesResponse = {
  story_id: STORY_ID,
  marginal_gain: 0.42,
  exposure_label: 'new_angle',
  redundancy_classes: 3,
  source: {
    name: 'Public Records Office',
    publisher_lineage: ['Public Records Office', 'Regional Wire Group'],
  },
  confirmed_syndication_count: 2,
  co_group_stories: [
    {
      story_id: CO_STORY_ID,
      title: 'Wire copy of the water dataset story',
      relationship: 'syndicated',
    },
  ],
  primary_sources: [{ url: 'https://records.example.org/dataset.csv', title: 'Raw dataset (CSV)' }],
};

const emptyResponse: IndependentSourcesResponse = {
  story_id: STORY_ID,
  marginal_gain: null,
  exposure_label: null,
  redundancy_classes: 0,
  source: null,
  confirmed_syndication_count: 0,
  co_group_stories: [],
  primary_sources: [],
};

const claims = {
  items: [
    {
      claim_id: '55555555-5555-4555-8555-555555555551',
      story_id: STORY_ID,
      canonical_text: 'Contaminant levels fell after the filtration upgrade.',
      claim_status: 'accepted' as const,
      first_seen_story_id: null,
      independence_group_id: '66666666-6666-4666-8666-666666666666',
      extraction_source: 'system' as const,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      claim_id: '55555555-5555-4555-8555-555555555552',
      story_id: STORY_ID,
      canonical_text: 'The methodology annex was published alongside the data.',
      claim_status: 'candidate' as const,
      first_seen_story_id: null,
      independence_group_id: null,
      extraction_source: 'user' as const,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
};

afterEach(() => vi.clearAllMocks());

function open(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Independent sources' }));
}

describe('IndependentSourcesDrawer (SPEC §7.6)', () => {
  it('fetches nothing until the sheet is opened (lazy reads)', () => {
    render(<IndependentSourcesDrawer storyId={STORY_ID} />, { wrapper: Providers });
    expect(screen.getByRole('button', { name: 'Independent sources' })).toBeInTheDocument();
    expect(api.fetchIndependentSources).not.toHaveBeenCalled();
    expect(api.fetchStoryClaims).not.toHaveBeenCalled();
  });

  it('renders every section from a populated payload', async () => {
    vi.mocked(api.fetchIndependentSources).mockResolvedValue(fullResponse);
    vi.mocked(api.fetchStoryClaims).mockResolvedValue(claims);
    render(<IndependentSourcesDrawer storyId={STORY_ID} />, { wrapper: Providers });
    open();
    expect(api.fetchIndependentSources).toHaveBeenCalledWith(STORY_ID);
    expect(api.fetchStoryClaims).toHaveBeenCalledWith(STORY_ID);

    // Exposure — plain language, plus the fixed doctrine caption (repetition
    // must never read as truth).
    expect(await screen.findByText('New angle')).toBeInTheDocument();
    expect(screen.getByText('Repetition is not independence.')).toBeInTheDocument();
    expect(screen.getByText(/Marginal information gain: 0\.42/)).toBeInTheDocument();
    expect(screen.getByText(/Redundancy classes on this topic: 3/)).toBeInTheDocument();

    // Source — name + publisher lineage chain + syndication count.
    expect(screen.getByText('Public Records Office')).toBeInTheDocument();
    expect(
      screen.getByText(/Publisher lineage: Public Records Office → Regional Wire Group/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Confirmed syndications: 2/)).toBeInTheDocument();

    // Same coverage — a link to the co-group story with its relationship.
    const coLink = screen.getByRole('link', { name: 'Wire copy of the water dataset story' });
    expect(coLink).toHaveAttribute('href', `/stories/${CO_STORY_ID}`);
    expect(screen.getByText('syndicated')).toBeInTheDocument();

    // Primary sources — marked as steward-reviewed, and rendered through the
    // MANDATED drainer-safe link flow (SafeExternalLink): the anchor carries
    // rel="noreferrer nofollow" and its click runs the blocklist/heuristics
    // check before any navigation — a steward's provenance mark never exempts
    // the destination from the reader-side safety interstitial.
    expect(screen.getByText('Reviewed by an evidence steward.')).toBeInTheDocument();
    const primary = screen.getByRole('link', { name: 'Raw dataset (CSV)' });
    expect(primary).toHaveAttribute('href', 'https://records.example.org/dataset.csv');
    expect(primary).toHaveAttribute('rel', 'noreferrer nofollow');
    expect(primary).toHaveAttribute('target', '_blank');

    // Claims — text plus the subtle independence-group annotation on the
    // grouped claim only.
    expect(
      screen.getByText('Contaminant levels fell after the filtration upgrade.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The methodology annex was published alongside the data.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('lineage group 1')).toHaveLength(1);
  });

  it.each([
    ['independent_source', 'Independent source'],
    ['same_claim_new_evidence', 'Same claim, new evidence'],
    ['duplicate_context', 'Duplicate context'],
  ] as const)('renders the %s exposure label as plain language', async (label, copy) => {
    vi.mocked(api.fetchIndependentSources).mockResolvedValue({
      ...fullResponse,
      exposure_label: label,
    });
    vi.mocked(api.fetchStoryClaims).mockResolvedValue({ items: [] });
    render(<IndependentSourcesDrawer storyId={STORY_ID} />, { wrapper: Providers });
    open();
    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  it('is absence-honest when MERI has not covered the story yet', async () => {
    vi.mocked(api.fetchIndependentSources).mockResolvedValue(emptyResponse);
    vi.mocked(api.fetchStoryClaims).mockResolvedValue({ items: [] });
    render(<IndependentSourcesDrawer storyId={STORY_ID} />, { wrapper: Providers });
    open();
    expect(await screen.findByText('Not yet computed')).toBeInTheDocument();
    expect(screen.getByText('The source lineage has not been mapped yet.')).toBeInTheDocument();
    expect(screen.getByText(/Confirmed syndications: 0/)).toBeInTheDocument();
    // Empty collections hide their sections entirely — nothing is fabricated.
    expect(screen.queryByText('Same coverage')).not.toBeInTheDocument();
    expect(screen.queryByText('Primary sources')).not.toBeInTheDocument();
    expect(screen.queryByText('Claims')).not.toBeInTheDocument();
    expect(screen.queryByText(/Marginal information gain/)).not.toBeInTheDocument();
  });

  it('reports a failed read instead of rendering fabricated content', async () => {
    vi.mocked(api.fetchIndependentSources).mockRejectedValue(new Error('not computed'));
    vi.mocked(api.fetchStoryClaims).mockRejectedValue(new Error('not computed'));
    render(<IndependentSourcesDrawer storyId={STORY_ID} />, { wrapper: Providers });
    open();
    expect(await screen.findByText(/Source independence could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('Not yet computed')).not.toBeInTheDocument();
  });

  it('has no accessibility violations with the sheet open', async () => {
    vi.mocked(api.fetchIndependentSources).mockResolvedValue(fullResponse);
    vi.mocked(api.fetchStoryClaims).mockResolvedValue(claims);
    render(<IndependentSourcesDrawer storyId={STORY_ID} />, { wrapper: Providers });
    open();
    await screen.findByText('New angle');
    // The sheet renders through a portal on document.body, so audit the body.
    expect(await checkA11y(document.body)).toHaveNoViolations();
  });
});
