// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LensPublic } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { CommentViewSelector, lensIdOfView, viewLabel } from './CommentViewSelector.js';

const lens = (over: Partial<LensPublic> & Pick<LensPublic, 'lens_id' | 'name'>): LensPublic => ({
  room_id: 'r1',
  lens_type: 'skeptical',
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('CommentViewSelector helpers', () => {
  it('extracts a lens id only from a lens view', () => {
    expect(lensIdOfView('lens:abc')).toBe('abc');
    expect(lensIdOfView('newest')).toBeNull();
    expect(lensIdOfView('participation')).toBeNull();
  });

  it('labels sorts plainly and lenses with a "Lens:" prefix', () => {
    const lenses = [lens({ lens_id: 'abc', name: 'Skeptical' })];
    expect(viewLabel('newest', lenses)).toBe('Newest first');
    expect(viewLabel('oldest', lenses)).toBe('Oldest first');
    expect(viewLabel('participation', lenses)).toBe('Highest participation');
    expect(viewLabel('lens:abc', lenses)).toBe('Lens: Skeptical');
    // A stale lens id falls back to the default sort label.
    expect(viewLabel('lens:gone', lenses)).toBe('Oldest first');
  });
});

describe('CommentViewSelector', () => {
  const lenses = [
    lens({ lens_id: 'a', name: 'Skeptical' }),
    lens({ lens_id: 'b', name: 'Industry' }),
  ];
  const counts = new Map([
    ['a', 2],
    ['b', 1],
  ]);

  it('lists the sorts + lenses and marks the active one', () => {
    render(
      <CommentViewSelector
        view="participation"
        roomLenses={lenses}
        lensCounts={counts}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Newest first' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skeptical (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Highest participation' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('omits the lens group when the room has fewer than two lenses', () => {
    render(
      <CommentViewSelector
        view="oldest"
        roomLenses={[lens({ lens_id: 'a', name: 'Skeptical' })]}
        lensCounts={counts}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText(/by interpretation lens/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Oldest first' })).toBeInTheDocument();
  });

  it('reports the selected value', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <CommentViewSelector
        view="oldest"
        roomLenses={lenses}
        lensCounts={counts}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Skeptical (2)' }));
    expect(onSelect).toHaveBeenCalledWith('lens:a');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <CommentViewSelector
        view="oldest"
        roomLenses={lenses}
        lensCounts={counts}
        onSelect={vi.fn()}
      />,
    );
    await checkA11y(container);
  });
});
