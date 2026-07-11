// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scenario presets for the DEV traffic simulator. A scenario is a declarative
// shaping of the persona archetype rates plus a small amount of orchestration
// (a kickoff story, a focus target, cluster/newcomer provisioning). The
// adversarial presets are deliberate: coordinated_burst runs FRESH accounts in
// a synchronized hammer so testers can watch the real WS-E anti-signal
// detectors and the WS-J coordinated-report intake respond; breaking_news
// shows the volume-trigger early scoring and the dedup fold; influx shows
// new-account handling. Rates are multipliers over the archetype baselines.

import type { SimulatorScenarioId, SimulatorScenarioInfo } from '@licio/shared';

export interface ScenarioRateShape {
  readonly story: number;
  readonly comment: number;
  readonly attention: number;
  readonly join: number;
  readonly report: number;
  /** WS-T sourced-correction rate (the challenge-resolution load). */
  readonly correction: number;
}

export interface ScenarioDefinition {
  readonly id: SimulatorScenarioId;
  readonly label: string;
  readonly description: string;
  /** Multipliers applied over every organic archetype's base rates. */
  readonly rates: ScenarioRateShape;
  /** Extra multiplier as a function of time since the scenario started
   *  (breaking_news decays; everything else is flat). */
  readonly phase?: (elapsedMs: number) => number;
  /** Share of comment/attention actions redirected at the focus story. */
  readonly focusBias: number;
  /** Submit a scenario kickoff story and make it the focus. */
  readonly kickoffStory: boolean;
  /** Submit one intentional near-duplicate of the focus story once the
   *  scenario has run this long (null = never). */
  readonly repostAfterMs: number | null;
  /** Activate the fresh-account cluster at these multiplied rates. */
  readonly cluster: { attention: number; comment: number; report: number } | null;
  /** Provision this many newcomer accounts per minute (cap applies). */
  readonly newcomersPerMinute: number;
  /** Share of planned comments swapped for a PROBLEM body (spam wording /
   *  hostile wording) so the WS-J floor pre-screen and the WS-U in-room
   *  moderation model classify genuinely actionable content — not only civil
   *  prose (0 = every comment stays civil). */
  readonly problemCommentShare: number;
  /** Share of sourced corrections carrying a `[sim:debate=…]`/
   *  `[sim:rationale-url]` failure-injection marker for the DEV simulated
   *  governance-LLM runtime — forcing a verdict class or a fail-closed
   *  MLP fallback under load. Inert prose against a real local runtime. */
  readonly debateMarkerShare: number;
}

const FLAT: ScenarioRateShape = {
  story: 1,
  comment: 1,
  attention: 1,
  join: 1,
  report: 1,
  correction: 1,
};

export const SCENARIOS: Readonly<Record<SimulatorScenarioId, ScenarioDefinition>> = {
  steady: {
    id: 'steady',
    label: 'Steady community',
    description:
      'A balanced day: new stories every few minutes, continuous reading, threaded discussion, the occasional report.',
    rates: FLAT,
    focusBias: 0,
    kickoffStory: false,
    repostAfterMs: null,
    cluster: null,
    newcomersPerMinute: 0,
    problemCommentShare: 0.05,
    debateMarkerShare: 0,
  },
  breaking_news: {
    id: 'breaking_news',
    label: 'Breaking story',
    description:
      'A developing story lands, reading surges and decays, follow-ups and one verbatim repost arrive — watch early scoring and the duplicate fold.',
    rates: { story: 1.6, comment: 2.5, attention: 3.5, join: 1.2, report: 1, correction: 1.5 },
    phase: (elapsedMs) => 1 + 3 * Math.exp(-elapsedMs / (8 * 60_000)),
    focusBias: 0.65,
    kickoffStory: true,
    repostAfterMs: 2 * 60_000,
    cluster: null,
    newcomersPerMinute: 0,
    problemCommentShare: 0.05,
    debateMarkerShare: 0,
  },
  viral_thread: {
    id: 'viral_thread',
    label: 'Runaway thread',
    description:
      'One discussion cascades: nested replies pile up and readers keep returning — watch thread depth and participation signals.',
    rates: { story: 0.4, comment: 4, attention: 2.5, join: 1, report: 1, correction: 2.5 },
    focusBias: 0.8,
    kickoffStory: true,
    repostAfterMs: null,
    cluster: null,
    newcomersPerMinute: 0,
    problemCommentShare: 0.06,
    debateMarkerShare: 0,
  },
  coordinated_burst: {
    id: 'coordinated_burst',
    label: 'Coordinated burst',
    description:
      'A cluster of fresh accounts hammers one story with synchronized reading, near-identical replies, and reports — watch the anti-signal dampening and integrity intake respond.',
    rates: FLAT,
    focusBias: 0.2,
    kickoffStory: true,
    repostAfterMs: null,
    // report multiplier × the cluster_member base (0.02) = ~1 report/min per
    // member at speed 1, so all 12 members file within the 300s coordination
    // window and the report count crosses the detector's minimum (10).
    cluster: { attention: 40, comment: 15, report: 50 },
    newcomersPerMinute: 0,
    problemCommentShare: 0.05,
    debateMarkerShare: 0,
  },
  influx: {
    id: 'influx',
    label: 'New-user influx',
    description:
      'A stream of brand-new accounts joins rooms and starts reading and posting lightly — watch new-account handling across the pipelines.',
    rates: { story: 0.8, comment: 1.2, attention: 1.3, join: 2, report: 1, correction: 0.5 },
    focusBias: 0,
    kickoffStory: false,
    repostAfterMs: null,
    cluster: null,
    newcomersPerMinute: 2,
    problemCommentShare: 0.08,
    debateMarkerShare: 0,
  },
  challenge_wave: {
    id: 'challenge_wave',
    label: 'Challenge wave',
    description:
      'A surge of sourced corrections: arenas open, both sides argue, the governed adjudicator rules, stewards overrule some — watch the full challenge-resolution lifecycle and the moderation model under load.',
    // Corrections dominate; comments stay elevated so fresh challengeable
    // targets keep appearing; attention keeps the feed reacting to dispute
    // outcomes (`incorrect` demotion / `validated` posture).
    rates: { story: 0.8, comment: 2, attention: 1.5, join: 1, report: 1, correction: 6 },
    focusBias: 0.45,
    kickoffStory: true,
    repostAfterMs: null,
    cluster: null,
    newcomersPerMinute: 0,
    problemCommentShare: 0.1,
    // ~1 in 8 corrections carries a failure-injection marker, so forced
    // verdict classes AND the fail-closed MLP fallback both occur under load
    // (the pulse's llm_unavailable counter visibly moves).
    debateMarkerShare: 0.12,
  },
  quiet: {
    id: 'quiet',
    label: 'Quiet night',
    description: 'Near-silence: rare reads and the odd comment — a baseline to compare against.',
    rates: { story: 0.1, comment: 0.1, attention: 0.15, join: 0.1, report: 0, correction: 0 },
    focusBias: 0,
    kickoffStory: false,
    repostAfterMs: null,
    cluster: null,
    newcomersPerMinute: 0,
    problemCommentShare: 0,
    debateMarkerShare: 0,
  },
};

/** Wire-shaped scenario catalogue for the status endpoint. */
export const SCENARIO_INFOS: readonly SimulatorScenarioInfo[] = Object.values(SCENARIOS).map(
  (s) => ({ id: s.id, label: s.label, description: s.description }),
);
