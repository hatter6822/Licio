// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DEVELOPMENT traffic-simulator control panel. It drives the dev-only
// /v1/dev/simulator control surface so a local tester can watch the feed react
// to a continuous stream of synthetic activity — new stories, live discussion,
// reading signals, reports — under different scenarios. This whole surface is
// rendered only in development (its route + the profile link are gated by
// import.meta.env.DEV, tree-shaken from production builds), and it degrades to
// an explicit "unavailable" card when the API has no simulator (production, or
// a dev boot with LICIO_SIM=off). The copy is deliberately descriptive: this
// platform has no likes/votes/karma, so the panel reports activity counts,
// ranked-position movement, and honest pipeline-rejection tallies — never a
// popularity score.

import type { SimulatorScenarioId, SimulatorStatus } from '@licio/shared';
import { SIMULATOR_MAX_SPEED, SIMULATOR_MIN_SPEED } from '@licio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  configureSimulator,
  fetchSimulatorStatus,
  SimulatorUnavailableError,
  startSimulator,
  stopSimulator,
} from '../../lib/dev-simulator-api.js';
import { Badge } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';
import { Card } from '../ui/Card/index.js';
import { EmptyState } from '../ui/EmptyState/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';
import { Select } from '../ui/Select/index.js';

const STATUS_KEY = ['dev-simulator', 'status'] as const;
const SPEED_STEPS = [0.5, 1, 2, 5, 10] as const;

function movementLabel(
  position: number,
  previous: number | null,
): {
  text: string;
  tone: 'up' | 'down' | 'same' | 'new';
} {
  if (previous === null) return { text: 'new to page', tone: 'new' };
  if (previous > position) return { text: `up ${previous - position}`, tone: 'up' };
  if (previous < position) return { text: `down ${position - previous}`, tone: 'down' };
  return { text: 'held', tone: 'same' };
}

function CounterTile({
  label,
  value,
  suffix = '',
}: {
  label: string;
  value: number;
  suffix?: string;
}): React.ReactElement {
  return (
    <div className="rounded-md border border-line bg-surface p-3 neu-inset">
      <div className="text-2xl font-semibold tabular-nums text-ink">
        {value.toLocaleString()}
        {suffix}
      </div>
      <div className="mt-1 text-xs text-ink-muted">{label}</div>
    </div>
  );
}

export function SimulatorPanel(): React.ReactElement {
  const queryClient = useQueryClient();
  const [pendingScenario, setPendingScenario] = useState<SimulatorScenarioId | null>(null);

  const statusQuery = useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => fetchSimulatorStatus(signal),
    refetchInterval: 4000,
    retry: false,
    staleTime: 0,
  });

  const applyStatus = (status: SimulatorStatus): void => {
    queryClient.setQueryData(STATUS_KEY, status);
  };

  const startMutation = useMutation({
    mutationFn: (scenario: SimulatorScenarioId | undefined) =>
      startSimulator(scenario ? { scenario } : {}),
    onSuccess: applyStatus,
  });
  const stopMutation = useMutation({ mutationFn: stopSimulator, onSuccess: applyStatus });
  const scenarioMutation = useMutation({
    mutationFn: (scenario: SimulatorScenarioId) => configureSimulator({ scenario }),
    onSuccess: applyStatus,
  });
  const speedMutation = useMutation({
    mutationFn: (speed: number) => configureSimulator({ speed }),
    onSuccess: applyStatus,
  });

  if (statusQuery.isLoading) {
    return <LoadingState label="Loading the traffic simulator…" />;
  }

  if (statusQuery.error instanceof SimulatorUnavailableError) {
    return (
      <EmptyState
        icon="sliders"
        title="Simulator not available"
        description="This API was not started with the development traffic simulator. Run the dev API (pnpm dev) — or set LICIO_SIM to a scenario — to enable it. It never runs in production."
      />
    );
  }

  if (statusQuery.error || !statusQuery.data) {
    return (
      <EmptyState
        icon="triangle-exclamation"
        title="Could not reach the simulator"
        description="The status request failed. Check that the dev API is running, then retry."
      />
    );
  }

  const status = statusQuery.data;
  const scenarioOptions = status.scenarios.map((s) => ({ value: s.id, label: s.label }));
  const activeScenario = status.scenarios.find((s) => s.id === status.scenario);
  const controlsBusy =
    startMutation.isPending ||
    stopMutation.isPending ||
    scenarioMutation.isPending ||
    speedMutation.isPending;

  return (
    <div className="flex flex-col gap-4">
      {/* Run state + primary controls */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge tone={status.running ? 'success' : 'neutral'}>
              {status.running ? 'Running' : 'Stopped'}
            </Badge>
            <span className="text-sm text-ink-muted">
              tick {status.tick_count.toLocaleString()} · {status.personas_active} synthetic
              participants · seed <code className="text-ink">{status.seed}</code>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {status.running ? (
              <Button
                variant="secondary"
                onClick={() => stopMutation.mutate()}
                disabled={controlsBusy}
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => startMutation.mutate(pendingScenario ?? undefined)}
                disabled={controlsBusy}
              >
                Start
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Select
              label="Scenario"
              value={status.scenario}
              options={scenarioOptions}
              onValueChange={(value) => {
                const scenario = value as SimulatorScenarioId;
                setPendingScenario(scenario);
                if (status.running) scenarioMutation.mutate(scenario);
              }}
            />
            {activeScenario ? (
              <p className="mt-2 text-xs text-ink-muted">{activeScenario.description}</p>
            ) : null}
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium text-ink">Speed ({status.speed}×)</span>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Simulator speed">
              {SPEED_STEPS.map((step) => (
                <Button
                  key={step}
                  variant={status.speed === step ? 'primary' : 'ghost'}
                  onClick={() => speedMutation.mutate(step)}
                  disabled={
                    controlsBusy || step < SIMULATOR_MIN_SPEED || step > SIMULATOR_MAX_SPEED
                  }
                  aria-pressed={status.speed === step}
                >
                  {step}×
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Activity counters */}
      <Card>
        <h2 className="text-sm font-semibold text-ink">Activity since boot</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <CounterTile label="Stories submitted" value={status.counters.stories_submitted} />
          <CounterTile label="Comments posted" value={status.counters.comments_posted} />
          <CounterTile label="Reads recorded" value={status.counters.attention_events_accepted} />
          <CounterTile label="Reports filed" value={status.counters.reports_filed} />
          <CounterTile label="Room joins" value={status.counters.room_joins} />
          <CounterTile label="Participants" value={status.counters.users_provisioned} />
          <CounterTile label="Signal refreshes" value={status.counters.signal_refreshes} />
          <CounterTile label="Rate-limited" value={status.counters.rejected_rate_limited} />
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Rejections are real pipeline responses, surfaced honestly:{' '}
          {status.counters.rejected_rate_limited} rate-limited, {status.counters.rejected_duplicate}{' '}
          duplicate, {status.counters.rejected_other} other, {status.counters.errors} errors. Story
          budget {status.world_story_count.toLocaleString()}/{status.story_cap.toLocaleString()}
          {status.story_cap_reached ? ' (reached — authors idle)' : ''}.
        </p>
      </Card>

      {/* Challenge-resolution throughput (WS-T corrections → debate arenas) */}
      <Card>
        <h2 className="text-sm font-semibold text-ink">Challenge resolutions</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Sourced corrections open real debate arenas; the governed AI adjudicator (
          {status.debate_pulse.llm_backend_active
            ? 'the LLM backend'
            : 'the deterministic fallback'}
          ) resolves them on shortened dev windows.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <CounterTile label="Corrections filed" value={status.counters.corrections_posted} />
          <CounterTile label="Arenas opened" value={status.counters.debates_opened} />
          <CounterTile label="Positions posted" value={status.counters.debate_positions_posted} />
          <CounterTile label="Awaiting verdict" value={status.debate_pulse.open_arenas} />
          <CounterTile label="Adjudicated" value={status.counters.debates_judged} />
          <CounterTile label="Finalized" value={status.counters.debates_finalized} />
          <CounterTile label="Forfeits" value={status.debate_pulse.forfeits} />
          <CounterTile label="Steward overrules" value={status.counters.debate_overrides} />
          <CounterTile label="LLM verdicts" value={status.debate_pulse.llm_decided} />
          <CounterTile label="LLM fallbacks" value={status.debate_pulse.llm_unavailable} />
          <CounterTile label="Overruled outcomes" value={status.debate_pulse.overridden} />
          <CounterTile
            label="Avg adjudication"
            value={status.debate_pulse.avg_adjudication_ms ?? 0}
            suffix={status.debate_pulse.avg_adjudication_ms !== null ? ' ms' : ''}
          />
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Resolved outcomes: {status.debate_pulse.resolved.corrected} corrected,{' '}
          {status.debate_pulse.resolved.upheld} upheld, {status.debate_pulse.resolved.inconclusive}{' '}
          inconclusive ({status.debate_pulse.overridden} by steward overrule). LLM verdict split:{' '}
          {status.debate_pulse.llm_verdicts.corrected} corrected,{' '}
          {status.debate_pulse.llm_verdicts.upheld} upheld,{' '}
          {status.debate_pulse.llm_verdicts.inconclusive} inconclusive;{' '}
          {status.debate_pulse.llm_unavailable} fell back to the deterministic adjudicator.
          {status.debate_pulse.last_judged_at !== null
            ? ` Last verdict ${new Date(status.debate_pulse.last_judged_at).toLocaleTimeString()}.`
            : ' No verdicts yet — arenas judge ~20s after they open.'}
        </p>
      </Card>

      {/* In-room moderation (WS-U — the bounded agent over governed rooms) */}
      <Card>
        <h2 className="text-sm font-semibold text-ink">In-room moderation</h2>
        <p className="mt-1 text-xs text-ink-muted">
          In governed rooms, the community-ratified moderation model (
          {status.moderation_pulse.llm_backend_active
            ? 'the LLM backend'
            : 'the deterministic default'}
          ) classifies every synthetic contribution; the platform wrapper bounds whatever it
          proposes (escalate-to-review ceiling + capability clamp).
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <CounterTile label="Model proposals" value={status.moderation_pulse.proposals} />
          <CounterTile
            label="Escalated to review"
            value={status.moderation_pulse.agent_escalations}
          />
          <CounterTile label="Model unavailable" value={status.moderation_pulse.unavailable} />
          <CounterTile label="Guard blocked" value={status.moderation_pulse.guard_blocked} />
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Proposed actions (before the wrapper's bound): {status.moderation_pulse.proposed.allow}{' '}
          allow, {status.moderation_pulse.proposed.warn} warn,{' '}
          {status.moderation_pulse.proposed.flag_for_review} flag for review,{' '}
          {status.moderation_pulse.proposed.restrict} restrict,{' '}
          {status.moderation_pulse.proposed.remove} remove. A proposed restrict/remove is clamped to
          flag-for-review — a human confirms first; unavailable calls degrade to the platform
          baseline and re-moderate later.
        </p>
      </Card>

      {/* Feed movement */}
      <Card>
        <h2 className="text-sm font-semibold text-ink">Front-page feed</h2>
        {status.feed_pulse.computed_at === null ? (
          <p className="mt-2 text-sm text-ink-muted">
            No ranked snapshot yet — it appears after the first signal refresh.
          </p>
        ) : status.feed_pulse.fallback ? (
          <p className="mt-2 text-sm text-ink-muted">
            The ranked pipeline is serving its chronological fallback right now.
          </p>
        ) : status.feed_pulse.items.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">The feed is empty.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2">
            {status.feed_pulse.items.map((item) => {
              const move = movementLabel(item.position, item.previous_position);
              return (
                <li
                  key={item.story_id}
                  className="flex items-center gap-3 rounded-md border border-line bg-surface p-2"
                >
                  <span className="w-6 text-right text-sm font-semibold tabular-nums text-ink-muted">
                    {item.position}
                  </span>
                  <span className="flex-1 truncate text-sm text-ink">{item.title}</span>
                  <Badge
                    tone={
                      move.tone === 'up'
                        ? 'success'
                        : move.tone === 'down'
                          ? 'warning'
                          : move.tone === 'new'
                            ? 'info'
                            : 'neutral'
                    }
                  >
                    {move.text}
                  </Badge>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {/* Live activity ticker */}
      <Card>
        <h2 className="text-sm font-semibold text-ink">Recent activity</h2>
        {status.recent_activity.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No activity yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {status.recent_activity.slice(0, 25).map((entry, index) => (
              <li
                key={`${entry.at}-${index}`}
                className="flex items-baseline gap-2 border-b border-line/50 py-1 last:border-b-0"
              >
                <span className="font-medium text-ink">{entry.actor}</span>
                <span
                  className={
                    entry.outcome === 'ok'
                      ? 'text-ink-muted'
                      : entry.outcome === 'rejected'
                        ? 'text-warning'
                        : 'text-error'
                  }
                >
                  {entry.summary}
                  {entry.detail ? ` (${entry.detail})` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
