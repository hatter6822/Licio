// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The development traffic-simulator control panel: it renders the current run
// state, honest activity counters, ranked-feed movement, and an activity
// ticker; degrades to an explicit "unavailable" card when the API has no
// simulator; and drives start/stop/scenario/speed over the mocked control API.
import type { SimulatorStatus } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider.js';

vi.mock('../../lib/dev-simulator-api.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/dev-simulator-api.js')>(
    '../../lib/dev-simulator-api.js',
  );
  return {
    ...actual,
    fetchSimulatorStatus: vi.fn(),
    startSimulator: vi.fn(),
    stopSimulator: vi.fn(),
    configureSimulator: vi.fn(),
  };
});

const api = await import('../../lib/dev-simulator-api.js');
const { SimulatorPanel } = await import('./SimulatorPanel.js');

function Providers({ children }: { children: ReactNode }): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nProvider locale="en">
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}

function status(over: Partial<SimulatorStatus> = {}): SimulatorStatus {
  return {
    running: true,
    scenario: 'steady',
    speed: 1,
    seed: 'licio-sim',
    started_at: '2026-07-04T00:00:00.000Z',
    tick_count: 12,
    personas_active: 27,
    world_story_count: 8,
    story_cap: 400,
    story_cap_reached: false,
    counters: {
      stories_submitted: 8,
      comments_posted: 40,
      attention_events_accepted: 210,
      attention_events_discarded: 2,
      room_joins: 5,
      reports_filed: 1,
      users_provisioned: 27,
      corrections_posted: 5,
      debates_opened: 4,
      debate_positions_posted: 3,
      debate_overrides: 1,
      debates_judged: 3,
      debates_finalized: 2,
      rejected_rate_limited: 3,
      rejected_duplicate: 1,
      rejected_other: 0,
      errors: 0,
      signal_refreshes: 4,
    },
    recent_activity: [
      {
        at: '2026-07-04T00:01:00.000Z',
        kind: 'story',
        actor: 'wren_marsh',
        summary: 'submitted a story',
        outcome: 'ok',
      },
      {
        at: '2026-07-04T00:00:30.000Z',
        kind: 'comment',
        actor: 'toby_grant',
        summary: 'comment rejected',
        outcome: 'rejected',
        detail: 'rate_limited',
      },
    ],
    feed_pulse: {
      computed_at: '2026-07-04T00:01:05.000Z',
      fallback: false,
      items: [
        {
          story_id: '5f5e1000-0000-4000-8000-000000000001',
          title: 'A rising story',
          position: 1,
          previous_position: 3,
        },
        {
          story_id: '5f5e1000-0000-4000-8000-000000000002',
          title: 'A new arrival',
          position: 2,
          previous_position: null,
        },
      ],
    },
    last_signal_refresh_at: '2026-07-04T00:01:05.000Z',
    debate_pulse: {
      open_arenas: 1,
      llm_backend_active: true,
      llm_verdicts: { upheld: 1, corrected: 2, inconclusive: 0 },
      llm_decided: 3,
      llm_unavailable: 0,
      resolved: { corrected: 1, upheld: 1, inconclusive: 0 },
      forfeits: 1,
      overridden: 1,
      avg_adjudication_ms: 850,
      last_judged_at: '2026-07-04T00:01:00.000Z',
    },
    moderation_pulse: {
      llm_backend_active: true,
      proposals: 12,
      proposed: { allow: 8, warn: 1, flag_for_review: 2, restrict: 0, remove: 1 },
      unavailable: 1,
      guard_blocked: 0,
      agent_escalations: 3,
    },
    scenarios: [
      { id: 'steady', label: 'Steady community', description: 'A balanced day.' },
      { id: 'breaking_news', label: 'Breaking story', description: 'A developing story.' },
    ],
    ...over,
  };
}

describe('SimulatorPanel', () => {
  it('renders run state, counters, and feed movement', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockResolvedValue(status());
    render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Stories submitted')).toBeInTheDocument();
    expect(screen.getByText('A rising story')).toBeInTheDocument();
    expect(screen.getByText('up 2')).toBeInTheDocument();
    expect(screen.getByText('new to page')).toBeInTheDocument();
    // The rejected activity entry surfaces with its code.
    expect(screen.getByText(/comment rejected \(rate_limited\)/)).toBeInTheDocument();
    // The WS-T challenge-resolution pulse (corrections → arenas → verdicts →
    // forfeits/overrules/resolved outcomes).
    expect(screen.getByText('Challenge resolutions')).toBeInTheDocument();
    expect(screen.getByText('Corrections filed')).toBeInTheDocument();
    expect(screen.getByText('Avg adjudication')).toBeInTheDocument();
    expect(screen.getByText('Forfeits')).toBeInTheDocument();
    expect(screen.getByText('Steward overrules')).toBeInTheDocument();
    expect(
      screen.getByText(/Resolved outcomes: 1 corrected, 1 upheld, 0 inconclusive/),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 corrected, 1 upheld, 0 inconclusive/)).toBeInTheDocument();
    // The WS-U in-room moderation pulse (the bounded agent over governed rooms).
    expect(screen.getByText('In-room moderation')).toBeInTheDocument();
    expect(screen.getByText('Model proposals')).toBeInTheDocument();
    expect(screen.getByText(/8 allow, 1 warn, 2 flag for review/)).toBeInTheDocument();
  });

  it('shows the unavailable state when the surface is absent', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockRejectedValue(new api.SimulatorUnavailableError());
    render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    expect(await screen.findByText('Simulator not available')).toBeInTheDocument();
  });

  it('shows a stopped run with a Start control', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockResolvedValue(status({ running: false }));
    render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('clicking Start from a stopped run calls startSimulator', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockResolvedValue(status({ running: false }));
    vi.mocked(api.startSimulator).mockResolvedValue(status({ running: true }));
    render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.startSimulator).toHaveBeenCalled());
  });

  it('clicking Stop while running calls stopSimulator', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockResolvedValue(status({ running: true }));
    vi.mocked(api.stopSimulator).mockResolvedValue(status({ running: false }));
    render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.stopSimulator).toHaveBeenCalled());
  });

  it('changing the speed calls configureSimulator with the new speed', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockResolvedValue(status({ running: true, speed: 1 }));
    vi.mocked(api.configureSimulator).mockResolvedValue(status({ running: true, speed: 5 }));
    render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    await screen.findByText('Running');
    fireEvent.click(screen.getByRole('button', { name: '5×' }));
    await waitFor(() =>
      expect(api.configureSimulator).toHaveBeenCalledWith(expect.objectContaining({ speed: 5 })),
    );
  });

  it('shows the story-cap-reached note and the fallback feed state', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockResolvedValue(
      status({
        world_story_count: 400,
        story_cap: 400,
        story_cap_reached: true,
        feed_pulse: { computed_at: '2026-07-04T00:01:05.000Z', fallback: true, items: [] },
      }),
    );
    render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    expect(await screen.findByText(/authors idle/)).toBeInTheDocument();
    expect(screen.getByText(/chronological fallback/)).toBeInTheDocument();
  });

  it('shows the empty states before the first refresh and with no activity', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockResolvedValue(
      status({
        recent_activity: [],
        feed_pulse: { computed_at: null, fallback: false, items: [] },
      }),
    );
    render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    expect(await screen.findByText(/No ranked snapshot yet/)).toBeInTheDocument();
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });

  it('has no axe violations in the running state', async () => {
    vi.mocked(api.fetchSimulatorStatus).mockResolvedValue(status());
    const { container } = render(
      <Providers>
        <SimulatorPanel />
      </Providers>,
    );
    await screen.findByText('Running');
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
