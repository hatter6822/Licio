// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CommentItem } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SourcesDialog } from './SourcesDialog.js';

function comment(overrides: Partial<CommentItem> = {}): CommentItem {
  return {
    contribution_id: '33333333-3333-4333-8333-333333333333',
    thread_id: '22222222-2222-4222-8222-222222222222',
    type: 'comment',
    body: '',
    citations: [],
    metadata: {},
    target_claim_id: null,
    parent_contribution_id: null,
    author_handle: 'alice',
    author_display_name: 'Alice',
    is_author: false,
    created_at: '2026-06-18T00:00:00.000Z',
    updated_at: '2026-06-18T00:00:00.000Z',
    edited: false,
    depth: 0,
    child_count: 0,
    moderation_state: 'published',
    dispute_status: 'none',
    active_debate_id: null,
    media: [],
    replies: [],
    reply_count: 0,
    has_more_replies: false,
    ...overrides,
  };
}

describe('SourcesDialog', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <SourcesDialog open={false} onClose={() => {}} comment={comment()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('derives each sourced statement from the body inline links + expands the URL', () => {
    render(
      <SourcesDialog
        open
        onClose={() => {}}
        comment={comment({
          body: 'The [official record](https://www.example.org/reports/vote) proves it.',
          citations: [{ url: 'https://www.example.org/reports/vote', title: 'official record' }],
        })}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Sources' });
    // The sourced statement (anchor text) is the footnote subject…
    expect(screen.getByText('official record')).toBeInTheDocument();
    // …and the URL is expanded (host emphasised, www stripped, path shown).
    expect(screen.getByText('example.org')).toBeInTheDocument();
    expect(screen.getByText('/reports/vote')).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://www.example.org/reports/vote');
    expect(dialog).toBeInTheDocument();
  });

  it('merges a legacy bare citation (no matching body link)', () => {
    render(
      <SourcesDialog
        open
        onClose={() => {}}
        comment={comment({
          body: 'No inline link here.',
          citations: [{ url: 'https://a.example/x' }],
        })}
      />,
    );
    // A bare legacy citation shows its URL as the statement + an expanded host.
    expect(screen.getByText('a.example')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://a.example/x');
  });

  it('shows an empty state when the comment has no sources', () => {
    render(<SourcesDialog open onClose={() => {}} comment={comment({ body: 'Just prose.' })} />);
    expect(screen.getByText('This comment has no attached sources.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
