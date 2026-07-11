// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WS-T challenge-resolution loop under synthetic load, end to end through
// the REAL pipelines: personas file sourced corrections (the real contribution
// guard chain), each opens a real debate arena (`maybeEnterDebate`), the
// simulator's per-tick lifecycle judges due arenas through the governed
// adjudicator (here: the real pinned-weights MLP; the dev boot swaps in the
// LLM leg) and finalizes them after the override window — with the windows
// shortened via the injectable `debateWindowsOverride` seam, exactly as the
// dev simulator runs. Asserts the throughput pulse the tester reads.

import { judgeDebate } from '@licio/ai-governance';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_ROSTER } from '../personas.js';
import { DevTrafficSimulator } from '../runtime.js';
import { buildSimTestGraph } from './sim-test-graph.js';
import { req } from './sim-test-util.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('WS-T challenge-resolution loop (corrections → arenas → verdicts)', () => {
  let sim: DevTrafficSimulator | null = null;
  afterEach(() => {
    sim?.stop();
    sim = null;
  });

  it('synthetic corrections open real arenas that the adjudicator judges and finalize with throughput metrics', {
    timeout: 90_000,
  }, async () => {
    const graph = await buildSimTestGraph();
    // The real deterministic MLP adjudicator (the sim graph's default judge is
    // the fail-closed null runner; the dev boot wires the governed LLM leg).
    graph.forum.debateJudge = async (_debateId, input) => ({
      verdict: judgeDebate(input),
      outputId: null,
    });
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'viral_thread',
      seed: 'debate-loop',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    expect(graph.forum.debateWindowsOverride).not.toBeNull(); // the sim shortens the windows
    // Shrink further so the loop resolves in test time: ~1.2s of rebuttal
    // window, instant finalize once judged.
    graph.forum.debateWindowsOverride = { editWindowMs: 1_200, overrideWindowMs: 1 };

    for (let i = 0; i < 200; i += 1) {
      await sim.tick();
      const c = sim.status().counters;
      if (c.debates_finalized > 0 && c.corrections_posted > 0) break;
      await sleep(25);
    }

    const status = sim.status();
    const { counters, debate_pulse } = status;
    // The full chain ran: corrections → arenas → verdicts → finalization.
    expect(counters.corrections_posted).toBeGreaterThan(0);
    expect(counters.debates_opened).toBeGreaterThan(0);
    expect(counters.debates_judged).toBeGreaterThan(0);
    expect(counters.debates_finalized).toBeGreaterThan(0);
    expect(counters.debates_judged).toBeGreaterThanOrEqual(counters.debates_finalized);
    // The throughput pulse a tester reads: lifecycle-measured latency + a
    // last-verdict timestamp; no LLM leg is wired in this graph.
    expect(debate_pulse.avg_adjudication_ms).not.toBeNull();
    expect(debate_pulse.last_judged_at).not.toBeNull();
    expect(debate_pulse.llm_backend_active).toBe(false);
    // (The activity ticker also carries `correction`/`debate` entries, but the
    // 40-entry status window scrolls fast under dense load — the counters
    // above are the durable proof both paths executed.)

    // stop() restores the §15.4 spec windows for whatever outlives the run.
    sim.stop();
    expect(graph.forum.debateWindowsOverride).toBeNull();
  });

  it('challenge_wave exercises the FULL arena lifecycle: forfeits, steward overrules, resolved outcomes', {
    timeout: 120_000,
  }, async () => {
    const graph = await buildSimTestGraph();
    graph.forum.debateJudge = async (_debateId, input) => ({
      verdict: judgeDebate(input),
      outputId: null,
    });
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'challenge_wave',
      seed: 'challenge-wave-loop',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    // Compressed windows: arenas judge ~1.2s after opening; the override
    // window spans ~8s so judged arenas linger long enough for the steward
    // persona's one-shot overrule roll AND still finalize inside the test.
    graph.forum.debateWindowsOverride = { editWindowMs: 1_200, overrideWindowMs: 8_000 };

    const done = (): boolean => {
      const s = sim ? sim.status() : null;
      if (s === null) return true;
      return (
        s.counters.debates_judged > 0 &&
        s.counters.debate_overrides > 0 &&
        s.debate_pulse.forfeits > 0 &&
        s.counters.debates_finalized > 0 &&
        s.debate_pulse.overridden > 0
      );
    };
    for (let i = 0; i < 600 && !done(); i += 1) {
      await sim.tick();
      await sleep(25);
    }

    const status = sim.status();
    const { counters, debate_pulse } = status;
    // Steward overrules executed through the REAL override path (the steward
    // persona is a real community_steward of the simulator's rooms).
    expect(counters.debate_overrides).toBeGreaterThan(0);
    // True forfeits occur (~30% of sim incumbents never answer): the
    // adjudicator judged genuinely one-sided debates.
    expect(debate_pulse.forfeits).toBeGreaterThan(0);
    // Arenas resolved, and the lifecycle outcome split accounts for exactly
    // the finalized arenas (both adjudicator legs, counted from the store).
    expect(counters.debates_finalized).toBeGreaterThan(0);
    const resolvedTotal =
      debate_pulse.resolved.corrected +
      debate_pulse.resolved.upheld +
      debate_pulse.resolved.inconclusive;
    expect(resolvedTotal).toBe(counters.debates_finalized);
    // At least one resolved arena was decided by the steward, not the AI.
    expect(debate_pulse.overridden).toBeGreaterThan(0);
    expect(debate_pulse.overridden).toBeLessThanOrEqual(resolvedTotal);
  });

  it('a RESTRICTED steward cannot record synthetic overrules (mirrors requireUnrestricted)', {
    timeout: 120_000,
  }, async () => {
    const graph = await buildSimTestGraph();
    graph.forum.debateJudge = async (_debateId, input) => ({
      verdict: judgeDebate(input),
      outputId: null,
    });
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'challenge_wave',
      seed: 'restricted-steward',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    graph.forum.debateWindowsOverride = { editWindowMs: 1_200, overrideWindowMs: 8_000 };
    // A moderation experiment restricts the steward AFTER provisioning. The
    // real route chain (authMiddleware + requireVerifiedAccount +
    // requireUnrestricted) would deny the overrule; the simulator calls
    // overrideDebateVerdict directly, so its own gate must bite instead.
    const steward = req(BASE_ROSTER.find((p) => p.archetype === 'room_steward'));
    await graph.identity.store.updateUser(steward.userId, { accountState: 'restricted' });

    let guardFired = false;
    for (let i = 0; i < 600 && !guardFired; i += 1) {
      await sim.tick();
      guardFired = sim
        .status()
        .recent_activity.some(
          (e) =>
            e.kind === 'debate' &&
            e.detail === 'account_restricted' &&
            e.summary === 'account barred from overruling',
        );
      await sleep(25);
    }

    const status = req(sim).status();
    // The engine PLANNED an overrule and the account-state gate rejected it…
    expect(guardFired).toBe(true);
    // …so no overrule was ever recorded from the restricted account.
    expect(status.counters.debate_overrides).toBe(0);
    expect(status.debate_pulse.overridden).toBe(0);
  });
});
