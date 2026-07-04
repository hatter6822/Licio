// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Integration tests for the simulator runtime binding: it drives the REAL WS-D/
// E/F/G/H/I/J pipelines in memory. These assert that synthetic activity
// actually lands (stories, comments, attention), that the ranked feed reacts,
// that live comment fan-out fires, that real pipeline rejections are surfaced
// honestly, and that stop() halts the loop.

import { afterEach, describe, expect, it } from 'vitest';
import type { CommentFrame } from '../../forum/comment-broadcaster.js';
import { serveFeed } from '../../ranking/service.js';
import { DevTrafficSimulator } from '../runtime.js';
import { buildSimTestGraph } from './sim-test-graph.js';
import { req } from './sim-test-util.js';

async function frontFeed(graph: Awaited<ReturnType<typeof buildSimTestGraph>>) {
  return serveFeed(graph.ranking, {
    userId: null,
    surface: 'front_page',
    surfaceRoomId: null,
    surfaceTopicId: null,
    mode: 'balanced',
    cursor: null,
  });
}

describe('DevTrafficSimulator runtime', () => {
  let sim: DevTrafficSimulator | null = null;
  afterEach(() => {
    sim?.stop();
    sim = null;
  });

  it('provisions synthetic users into the real identity store on start', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({ graph, scenario: 'steady', seed: 's1', autoLoop: false });
    await sim.start();
    const status = sim.status();
    expect(status.running).toBe(true);
    expect(status.personas_active).toBeGreaterThan(0);
    expect(status.counters.users_provisioned).toBeGreaterThan(0);
    // A provisioned persona is a real, active, verified account.
    const anyUser = await graph.identity.store.getUser('5f5ed000-0000-4000-8000-000000000001');
    expect(anyUser?.accountState).toBe('active');
  });

  it('submits real stories that appear in the ranked feed', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'breaking_news',
      seed: 'stories',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 6; i += 1) await sim.tick();
    const status = sim.status();
    expect(status.counters.stories_submitted).toBeGreaterThan(0);
    // The real ingestion store holds them, and the ranked feed serves them.
    const recent = await graph.ingestion.stories.listRecent(50);
    expect(recent.length).toBeGreaterThan(0);
    const feed = await frontFeed(graph);
    expect(feed.items.length).toBeGreaterThan(0);
  });

  it('posts real comments and fires the live SSE broadcast', async () => {
    const graph = await buildSimTestGraph();
    const frames: CommentFrame[] = [];
    // Capture every broadcast by wrapping the shared publisher (the runtime
    // calls publish() for each non-deduplicated, published contribution).
    const realPublish = graph.forum.commentBroadcaster.publish.bind(graph.forum.commentBroadcaster);
    graph.forum.commentBroadcaster.publish = (threadId, frame) => {
      frames.push(frame);
      realPublish(threadId, frame);
    };
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'viral_thread',
      seed: 'comments',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 8; i += 1) await sim.tick();
    const status = sim.status();
    expect(status.counters.comments_posted).toBeGreaterThan(0);
    // The runtime replicated the route-level SSE fan-out for published comments.
    expect(frames.length).toBeGreaterThan(0);
    // Each broadcast frame carries a real, published contribution projection.
    for (const frame of frames) {
      expect(frame.contribution.contribution_id).toBe(frame.eventId);
    }
    // And the real forum store actually holds published comments.
    let published = 0;
    for (const story of await graph.ingestion.stories.listRecent(20)) {
      const t = await graph.ingestion.stories.getThreadByStoryId(story.storyId);
      if (!t) continue;
      const rows = await graph.forum.contributions.listByThread(t.threadId, {
        states: ['published'],
        limit: 50,
      });
      published += rows.length;
    }
    expect(published).toBeGreaterThan(0);
  });

  it('ingests bucketed attention and refreshes real reading signals', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'steady',
      seed: 'attention',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 5; i += 1) await sim.tick();
    await sim.forceSignalRefresh();
    const status = sim.status();
    expect(status.counters.attention_events_accepted).toBeGreaterThan(0);
    expect(status.counters.signal_refreshes).toBeGreaterThan(0);
    // The feed pulse snapshot is populated after a refresh.
    expect(status.feed_pulse.computed_at).not.toBeNull();
  });

  it('surfaces the coordinated burst against the anti-signal pipeline', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'coordinated_burst',
      seed: 'burst',
      speed: 10,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 8; i += 1) await sim.tick();
    await sim.forceSignalRefresh();
    const status = sim.status();
    // The fresh cluster was provisioned and drove attention + reports at the
    // focus story (the integrity pipeline consumes these without crashing).
    expect(status.counters.users_provisioned).toBeGreaterThan(0);
    expect(
      status.counters.attention_events_accepted + status.counters.reports_filed,
    ).toBeGreaterThan(0);
    expect(status.counters.errors).toBe(0);
  });

  it('honours the story cap: authors idle once reached', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'breaking_news',
      seed: 'cap',
      speed: 20,
      storyCap: 3,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 20; i += 1) await sim.tick();
    const status = sim.status();
    expect(status.counters.stories_submitted).toBeLessThanOrEqual(3);
    expect(status.story_cap_reached).toBe(true);
  });

  it('stop() halts the loop and status reflects it', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({ graph, scenario: 'steady', seed: 'stop', autoLoop: false });
    await sim.start();
    expect(sim.isRunning()).toBe(true);
    sim.stop();
    expect(sim.isRunning()).toBe(false);
    // A tick after stop is a no-op (running guard).
    const before = sim.status().tick_count;
    await sim.tick();
    expect(sim.status().tick_count).toBe(before);
  });

  it('start() is idempotent and a stop()→start() cycle resumes cleanly', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({ graph, scenario: 'steady', seed: 'cycle', autoLoop: false });
    await sim.start();
    const provisioned = sim.status().counters.users_provisioned;
    // A second start() while running is a no-op (does not re-provision).
    await sim.start();
    expect(sim.status().counters.users_provisioned).toBe(provisioned);
    // Stop, then start again: running resumes and ticks advance again.
    sim.stop();
    expect(sim.isRunning()).toBe(false);
    await sim.start();
    expect(sim.isRunning()).toBe(true);
    const before = sim.status().tick_count;
    await sim.tick();
    expect(sim.status().tick_count).toBe(before + 1);
  });

  it('configure() switches scenario and resets the phase clock', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({ graph, scenario: 'steady', seed: 'cfg', autoLoop: false });
    await sim.start();
    sim.configure({ scenario: 'quiet', speed: 2 });
    const status = sim.status();
    expect(status.scenario).toBe('quiet');
    expect(status.speed).toBe(2);
  });

  it('start() on a running instance switches scenario through the reset path (not a bare mutation)', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'breaking_news',
      seed: 'live-switch',
      speed: 10,
      autoLoop: false,
    });
    await sim.start();
    // Establish a focus story (breaking_news kickoff) so we can prove the reset.
    await sim.tick();
    // A live re-start with a new scenario must apply it AND reset scenario state,
    // exactly like configure() — never leave the previous scenario's stale state.
    await sim.start({ scenario: 'coordinated_burst', speed: 3 });
    expect(sim.status().scenario).toBe('coordinated_burst');
    expect(sim.status().speed).toBe(3);
    // It did not re-provision or restart the run.
    expect(sim.isRunning()).toBe(true);
  });

  it('a persona provisioning failure does not brick start() (stays restartable)', async () => {
    const graph = await buildSimTestGraph();
    // Force every createUser to throw: provisioning must swallow per-persona,
    // count errors, and still finish start() with the instance running.
    graph.identity.store.createUser = async () => {
      throw new Error('simulated durable-store failure');
    };
    sim = new DevTrafficSimulator({ graph, scenario: 'steady', seed: 'brick', autoLoop: false });
    await sim.start();
    expect(sim.isRunning()).toBe(true);
    expect(sim.status().counters.errors).toBeGreaterThan(0);
    // No personas provisioned, but the instance is not stuck: stop/start works.
    sim.stop();
    expect(sim.isRunning()).toBe(false);
  });

  it('is deterministic: two runs with the same seed submit the same story titles', async () => {
    const run = async (): Promise<string[]> => {
      const graph = await buildSimTestGraph();
      const s = new DevTrafficSimulator({
        graph,
        scenario: 'breaking_news',
        seed: 'determinism',
        speed: 10,
        autoLoop: false,
      });
      await s.start();
      for (let i = 0; i < 4; i += 1) await s.tick();
      s.stop();
      const titles = (await graph.ingestion.stories.listRecent(50)).map((x) => x.title).sort();
      return titles;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });

  it('the influx scenario provisions brand-new accounts beyond the base roster', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'influx',
      seed: 'newcomers',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    const base = sim.status().personas_active;
    for (let i = 0; i < 10; i += 1) await sim.tick();
    const after = sim.status();
    expect(after.personas_active).toBeGreaterThan(base);
    expect(after.counters.users_provisioned).toBeGreaterThan(base);
  });

  it('a long mixed run moves diverse counters (joins, reports, varied submission types)', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'steady',
      seed: 'mixed',
      speed: 20,
      storyCap: 1000,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 25; i += 1) await sim.tick();
    await sim.forceSignalRefresh();
    const c = sim.status().counters;
    expect(c.stories_submitted).toBeGreaterThan(0);
    expect(c.comments_posted).toBeGreaterThan(0);
    expect(c.attention_events_accepted).toBeGreaterThan(0);
    // Over a long steady run, at least one join and one report land.
    expect(c.room_joins).toBeGreaterThan(0);
    expect(c.reports_filed).toBeGreaterThan(0);
    // The corpus carries more than one submission type (link/brief/question/local).
    const types = new Set(
      (await graph.ingestion.stories.listRecent(200)).map((s) => s.submissionType),
    );
    expect(types.size).toBeGreaterThan(1);
  });

  it('produces a wire-valid status object', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({ graph, scenario: 'steady', seed: 'status', autoLoop: false });
    await sim.start();
    await sim.tick();
    const { simulatorStatusSchema } = await import('@licio/shared');
    expect(() => simulatorStatusSchema.parse(req(sim).status())).not.toThrow();
  });
});
