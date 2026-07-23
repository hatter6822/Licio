// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared page scaffold's HEADING contract. Every frame a body-titled page
// can render — loading, error, empty, content — must carry EXACTLY ONE `<h1>`:
// the WS-B.1.6 route-change focus manager takes the first `<h1>` inside
// `<main>`, so a missing one strands focus and a duplicate steals it. Pages
// whose content renders the headline itself (the story page puts it in the
// article card) opt in with `titleInContent`.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PageScaffold } from './PageScaffold.js';

type Query = {
  data: string | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

const loading: Query = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
const failed: Query = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
const loaded: Query = { data: 'body', isLoading: false, isError: false, refetch: vi.fn() };

function headings(): HTMLElement[] {
  return screen.getAllByRole('heading', { level: 1 });
}

describe('PageScaffold heading contract', () => {
  it('renders the body title on every frame by default', () => {
    for (const query of [loading, failed, loaded]) {
      const view = render(
        <PageScaffold title="Story headline" titlePlacement="body" query={query}>
          {(data) => <p>{data}</p>}
        </PageScaffold>,
      );
      expect(headings()).toHaveLength(1);
      expect(headings()[0]).toHaveTextContent('Story headline');
      view.unmount();
    }
  });

  it('with titleInContent, the scaffold still owns the heading while there is no content', () => {
    for (const query of [loading, failed]) {
      const view = render(
        <PageScaffold title="Story headline" titlePlacement="body" titleInContent query={query}>
          {(data) => <p>{data}</p>}
        </PageScaffold>,
      );
      expect(headings()).toHaveLength(1);
      view.unmount();
    }
  });

  it('with titleInContent, the scaffold yields the heading to the content frame', () => {
    render(
      <PageScaffold title="Story headline" titlePlacement="body" titleInContent query={loaded}>
        {(data) => (
          <article>
            <h1>Story headline</h1>
            <p>{data}</p>
          </article>
        )}
      </PageScaffold>,
    );
    // Exactly one — the content's, not the scaffold's copy beside it.
    expect(headings()).toHaveLength(1);
    expect(headings()[0]?.closest('article')).not.toBeNull();
  });

  it('an EMPTY result is a scaffold frame, so the heading comes back', () => {
    render(
      <PageScaffold
        title="Story headline"
        titlePlacement="body"
        titleInContent
        query={loaded}
        isEmpty={() => true}
        emptyTitle="Nothing here"
      >
        {(data) => (
          <article>
            <h1>Story headline</h1>
            <p>{data}</p>
          </article>
        )}
      </PageScaffold>,
    );
    expect(headings()).toHaveLength(1);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('leaves a header-titled page alone (the banner owns the <h1>)', () => {
    render(
      <PageScaffold title="Rooms" query={loaded}>
        {(data) => <p>{data}</p>}
      </PageScaffold>,
    );
    expect(headings()).toHaveLength(1);
    expect(headings()[0]).toHaveTextContent('Rooms');
  });
});
