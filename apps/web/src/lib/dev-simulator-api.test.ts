// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The dev traffic-simulator control client: zod-validates every response, sends
// the control header on mutations, and maps an absent surface (404 / network
// error) to SimulatorUnavailableError so the panel can render an honest
// "unavailable" state instead of an error.
import { SIMULATOR_CONTROL_HEADER, type SimulatorStatus } from '@licio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureSimulator,
  fetchSimulatorStatus,
  SimulatorUnavailableError,
  startSimulator,
  stopSimulator,
} from './dev-simulator-api.js';

function status(): SimulatorStatus {
  return {
    running: false,
    scenario: 'steady',
    speed: 1,
    seed: 'licio-sim',
    started_at: null,
    tick_count: 0,
    personas_active: 0,
    world_story_count: 0,
    story_cap: 400,
    story_cap_reached: false,
    counters: {
      stories_submitted: 0,
      comments_posted: 0,
      attention_events_accepted: 0,
      attention_events_discarded: 0,
      room_joins: 0,
      reports_filed: 0,
      users_provisioned: 0,
      corrections_posted: 0,
      debates_opened: 0,
      debate_positions_posted: 0,
      debate_overrides: 0,
      debates_judged: 0,
      debates_finalized: 0,
      rejected_rate_limited: 0,
      rejected_duplicate: 0,
      rejected_other: 0,
      errors: 0,
      signal_refreshes: 0,
    },
    recent_activity: [],
    feed_pulse: { computed_at: null, fallback: false, items: [] },
    last_signal_refresh_at: null,
    debate_pulse: {
      open_arenas: 0,
      llm_backend_active: false,
      llm_verdicts: { upheld: 0, corrected: 0, inconclusive: 0 },
      llm_decided: 0,
      llm_unavailable: 0,
      resolved: { corrected: 0, upheld: 0, inconclusive: 0 },
      forfeits: 0,
      overridden: 0,
      avg_adjudication_ms: null,
      last_judged_at: null,
    },
    moderation_pulse: {
      llm_backend_active: false,
      proposals: 0,
      proposed: { allow: 0, warn: 0, flag_for_review: 0, restrict: 0, remove: 0 },
      unavailable: 0,
      guard_blocked: 0,
      agent_escalations: 0,
    },
    scenarios: [{ id: 'steady', label: 'Steady', description: 'A balanced day.' }],
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dev-simulator-api client', () => {
  it('fetchSimulatorStatus returns the parsed status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status()));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchSimulatorStatus();
    expect(result.scenario).toBe('steady');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/dev/simulator/status'), {
      method: 'GET',
    });
  });

  it('maps a 404 to SimulatorUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 })));
    await expect(fetchSimulatorStatus()).rejects.toBeInstanceOf(SimulatorUnavailableError);
  });

  it('maps a network failure to SimulatorUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(fetchSimulatorStatus()).rejects.toBeInstanceOf(SimulatorUnavailableError);
  });

  it('startSimulator sends the control header and body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status()));
    vi.stubGlobal('fetch', fetchMock);
    await startSimulator({ scenario: 'breaking_news' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)[SIMULATOR_CONTROL_HEADER]).toBe('1');
    expect(init.body).toContain('breaking_news');
  });

  it('stopSimulator and configureSimulator POST with the header', async () => {
    // A fresh Response per call — a Response body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(status())));
    vi.stubGlobal('fetch', fetchMock);
    await stopSimulator();
    await configureSimulator({ speed: 5 });
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)[SIMULATOR_CONTROL_HEADER]).toBe('1');
    }
  });

  it('throws on a non-404 error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 })));
    await expect(fetchSimulatorStatus()).rejects.toThrow();
  });
});
