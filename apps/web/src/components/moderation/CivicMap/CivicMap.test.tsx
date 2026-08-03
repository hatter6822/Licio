// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.7.4 — the Civic Map panel.
//
// The properties under test are the ones that keep this an analyst diagram
// rather than a leaderboard, plus the accessibility contract a data
// visualisation owes:
//
//   • the sweep scalar (`level`) is NEVER printed and never orders the display;
//   • the SVG is hidden from assistive tech, and every fact in it also exists as
//     text, so a screen-reader user loses nothing;
//   • a fragile join is identified in words, not by colour or dash alone;
//   • the bridge action reaches the thread the server expects, and is suppressed
//     when there is no thread to target.
import type { CivicMapResponse } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { CivicMap } from './CivicMap.js';

const BASIN_A = '11111111-1111-4111-8111-111111111111';
const BASIN_B = '22222222-2222-4222-8222-222222222222';
const BASIN_C = '33333333-3333-4333-8333-333333333333';
const TOPIC = { id: '70b1c0de-0000-4000-8000-000000000001', name: 'Climate' };

function landscape(over: Partial<CivicMapResponse> = {}): CivicMapResponse {
  return {
    window: { start: '2026-08-02T10:00:00.000Z', end: '2026-08-02T11:00:00.000Z' },
    summary: {
      basin_count: 3,
      merge_count: 1,
      split_count: 1,
      fragile_saddle_count: 1,
      final_basin_count: 2,
    },
    basins: [
      {
        basin_id: BASIN_A,
        title: 'Flooding on the ring road',
        // A deliberately distinctive number so a printed level is detectable.
        level: 4242,
        thread_id: 'aaaaaaaa-1111-4111-8111-111111111111',
        topics: [TOPIC],
        final: true,
      },
      {
        basin_id: BASIN_B,
        title: 'Council budget vote',
        level: 17,
        thread_id: 'bbbbbbbb-2222-4222-8222-222222222222',
        topics: [TOPIC],
        final: false,
      },
      {
        basin_id: BASIN_C,
        title: 'Untargetable basin',
        level: 5,
        thread_id: null,
        topics: [],
        final: true,
      },
    ],
    merges: [
      {
        basin_a: BASIN_A,
        basin_b: BASIN_B,
        level: 12,
        connecting_edges: 2,
        fragile: true,
        survivor: BASIN_A,
        shared_topics: [TOPIC],
      },
    ],
    splits: [],
    coverage: 0.8,
    ...over,
  };
}

describe('CivicMap', () => {
  it('never prints the sweep scalar — it is an axis, not a score', () => {
    const { container } = render(<CivicMap data={landscape()} />);
    // 4242 is only ever a y-coordinate; it must appear nowhere in the text.
    expect(container.textContent).not.toContain('4242');
    expect(container.textContent).not.toMatch(/\btop\b|\bmost\b|\brank/i);
  });

  it('hides the diagram from assistive tech and carries every fact as text', async () => {
    const { container } = render(<CivicMap data={landscape()} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');

    // The structural summary is readable prose, not just a picture — and it
    // pluralises, so a single fragile join never reads "1 fragile joins".
    expect(screen.getByText(/3 clusters/)).toBeInTheDocument();
    expect(screen.getByText(/1 fragile join\b/)).toBeInTheDocument();
    expect(screen.getByText(/1 branch point\b/)).toBeInTheDocument();

    // Every basin is enumerated in the text list.
    const list = screen.getByText(/List every cluster/i);
    await userEvent.click(list);
    expect(screen.getByText('Flooding on the ring road')).toBeInTheDocument();
    expect(screen.getByText('Council budget vote')).toBeInTheDocument();
    expect(screen.getByText('Untargetable basin')).toBeInTheDocument();
  });

  it('names a fragile join in words, not by colour or dash alone', () => {
    render(<CivicMap data={landscape()} />);
    expect(screen.getByRole('heading', { name: /Fragile joins/i })).toBeInTheDocument();
    expect(screen.getByText(/are joined by 2 connections/i)).toBeInTheDocument();
    expect(screen.getByText(/Shared topics: Climate/i)).toBeInTheDocument();
  });

  it('routes the bridge action to the thread the server expects', async () => {
    const onOpenBridge = vi.fn();
    render(<CivicMap data={landscape()} onOpenBridge={onOpenBridge} />);
    // BOTH sides are offered: the bridge endpoint authorizes against the room of
    // the thread you name, so an analyst who stewards only the far side must be
    // able to pick it rather than be shown one button that always 404s.
    const buttons = screen.getAllByRole('button', { name: /^Bridge on/i });
    expect(buttons).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: /Flooding on the ring road/i }));
    expect(onOpenBridge).toHaveBeenCalledWith(
      'aaaaaaaa-1111-4111-8111-111111111111',
      'Flooding on the ring road',
    );
    await userEvent.click(screen.getByRole('button', { name: /Council budget vote/i }));
    expect(onOpenBridge).toHaveBeenCalledWith(
      'bbbbbbbb-2222-4222-8222-222222222222',
      'Council budget vote',
    );
  });

  it('offers no bridge action when neither basin has a thread', () => {
    const data = landscape({
      basins: landscape().basins.map((b) => ({ ...b, thread_id: null })),
    });
    render(<CivicMap data={data} onOpenBridge={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Bridge on/i })).toBeNull();
  });

  it('disables the action while its request is in flight', () => {
    render(
      <CivicMap
        data={landscape()}
        onOpenBridge={vi.fn()}
        pendingThreadIds={['aaaaaaaa-1111-4111-8111-111111111111']}
      />,
    );
    expect(screen.getByRole('button', { name: /opening/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // …and only THAT target is disabled; the other side stays actionable.
    expect(screen.getByRole('button', { name: /Council budget vote/i })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('says so when the landscape is mostly unconnected points', () => {
    render(<CivicMap data={landscape({ coverage: 0.1 })} />);
    expect(screen.getByRole('note')).toHaveTextContent(/share no topic with another/i);
  });

  it('reports when the diagram shows fewer basins than exist', () => {
    const many = Array.from({ length: 20 }, (_unused, i) => ({
      basin_id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      title: `Basin ${i}`,
      level: 20 - i,
      thread_id: null,
      topics: [],
      final: true,
    }));
    render(
      <CivicMap
        data={landscape({
          basins: many,
          merges: [],
          summary: { ...landscape().summary, basin_count: 20 },
        })}
      />,
    );
    expect(screen.getByText(/showing 12 in the diagram/i)).toBeInTheDocument();
  });

  it('orders the display neutrally, not by the engagement it was handed', async () => {
    // The response arrives peak-order, which the sweep makes descending by
    // level (4242, 17, 5). Rendering it as given would publish that ranking
    // without a single sort in the component. The visible order must be
    // alphabetical instead.
    render(<CivicMap data={landscape()} />);
    await userEvent.click(screen.getByText(/List every cluster/i));
    // Scope to the cluster list: the fragile-join list above it names basins too.
    const clusterList = screen.getByText(/List every cluster/i).parentElement;
    const titles = [...(clusterList?.querySelectorAll('li') ?? [])].map(
      (li) => li.textContent ?? '',
    );
    expect(titles[0]).toMatch(/Council budget vote/);
    expect(titles[1]).toMatch(/Flooding on the ring road/);
    expect(titles[2]).toMatch(/Untargetable basin/);
  });

  it('stops an absorbed stem at its saddle instead of drawing past it', () => {
    // BASIN_B loses the merge at level 12. A merge tree in which both branches
    // continue below their join is not a tree, and the phantom stem would
    // contradict `final`.
    const { container } = render(<CivicMap data={landscape()} />);
    // The FIRST svg is the map; later ones are icons with lines of their own.
    const lines = [...(container.querySelector('svg')?.querySelectorAll('line') ?? [])];
    const baseline = lines.find((line) => line.getAttribute('x1') === '0');
    const floor = baseline?.getAttribute('y1');
    expect(floor).toBeDefined();

    const stems = lines.filter((line) => line.getAttribute('x1') === line.getAttribute('x2'));
    expect(stems).toHaveLength(3);
    const cut = stems.filter((line) => line.getAttribute('y2') !== floor);
    expect(cut).toHaveLength(1);

    // …and it stops EXACTLY at the join, not merely somewhere short of the floor.
    const join = lines.find((line) => line.getAttribute('stroke-dasharray') !== null);
    expect(cut[0]?.getAttribute('y2')).toBe(join?.getAttribute('y1'));
  });

  it('describes every join in words, not only the actionable ones', async () => {
    const data = landscape({
      merges: [
        ...landscape().merges,
        {
          basin_a: BASIN_A,
          basin_b: BASIN_C,
          level: 3,
          connecting_edges: 9,
          fragile: false,
          survivor: BASIN_A,
          shared_topics: [],
        },
      ],
    });
    render(<CivicMap data={data} />);
    // The sturdy join has no bridge action, so the fragile list omits it — but
    // the diagram draws it, and a screen-reader user must learn it exists.
    await userEvent.click(screen.getByText(/List every join/i));
    expect(
      screen.getByText(
        /“Flooding on the ring road” and “Untargetable basin” join by 9 connections/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/join by 2 connections.*fragile/)).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CivicMap data={landscape()} onOpenBridge={vi.fn()} />);
    await checkA11y(container);
  });
});
