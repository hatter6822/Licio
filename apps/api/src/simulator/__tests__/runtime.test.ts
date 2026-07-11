// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Integration tests for the simulator runtime binding: it drives the REAL WS-D/
// E/F/G/H/I/J pipelines in memory. These assert that synthetic activity
// actually lands (stories, comments, attention), that the ranked feed reacts,
// that live comment fan-out fires, that real pipeline rejections are surfaced
// honestly, and that stop() halts the loop.

import { afterEach, describe, expect, it } from 'vitest';
import {
  createInMemoryAiGovernanceServices,
  setAiGovernanceServices,
} from '../../ai-governance/services.js';
import type { CommentFrame } from '../../forum/comment-broadcaster.js';
import { serveFeed } from '../../ranking/service.js';
import { MAX_ACTIONS_PER_TICK, type SimAction, type SimWorld } from '../engine.js';
import { BASE_ROSTER, CLUSTER_ROSTER, newcomerSpec } from '../personas.js';
import {
  __resetSimStoryMetaForTest,
  __simStoryMetaSizeForTest,
  consumedDebateChances,
  DevTrafficSimulator,
  ROOM_GOVERNED_TTL_MS,
} from '../runtime.js';
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
    let lensTagged = 0;
    for (const story of await graph.ingestion.stories.listRecent(20)) {
      const t = await graph.ingestion.stories.getThreadByStoryId(story.storyId);
      if (!t) continue;
      const rows = await graph.forum.contributions.listByThread(t.threadId, {
        states: ['published'],
        limit: 50,
      });
      published += rows.length;
      lensTagged += rows.filter((r) => typeof r.metadata['lens_id'] === 'string').length;
    }
    expect(published).toBeGreaterThan(0);
    // WS-G.2.2 — synthetic traffic tags root comments with an interpretation
    // lens through the REAL createContribution path (room-validated), so SCOI
    // lens divergence is exercised end to end, not only by the S10 seed.
    expect(lensTagged).toBeGreaterThan(0);
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
    const organic = sim.status().personas_active;
    for (let i = 0; i < 10; i += 1) await sim.tick();
    await sim.forceSignalRefresh();
    const status = sim.status();
    // The fresh cluster actually provisioned (grew the roster by CLUSTER_ROSTER)
    // — the scenario is not silently running with only organic users.
    expect(status.personas_active).toBe(organic + CLUSTER_ROSTER.length);
    // and drove attention + reports at the focus story (the integrity pipeline
    // consumes these without crashing).
    expect(
      status.counters.attention_events_accepted + status.counters.reports_filed,
    ).toBeGreaterThan(0);
    expect(status.counters.errors).toBe(0);
  });

  it('coordinated_burst files enough distinct reports to cross the WS-J detector, without double-counting', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'coordinated_burst',
      seed: 'reports',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 20; i += 1) await sim.tick();
    const filed = sim.status().counters.reports_filed;
    // Crosses the detector minimum (10 reports). Idempotent repeats — every
    // cluster member hammers the SAME focus story with the SAME reason each tick
    // — are NOT counted, so the tally plateaus near the distinct reporter count
    // (12 cluster + a few organic) rather than climbing into the hundreds it
    // would without the idempotency guard.
    expect(filed).toBeGreaterThanOrEqual(10);
    expect(filed).toBeLessThanOrEqual(CLUSTER_ROSTER.length + 6);
  });

  it('never generates attention against a private room_only story (visibility bar)', async () => {
    const graph = await buildSimTestGraph();
    // A private room + a room_only story owned by a non-simulator user: no
    // synthetic persona is a member, so it must never enter the world nor
    // receive simulator attention.
    const privateRoomId = 'b0000000-0000-4000-8000-000000000001';
    await graph.forum.rooms.insert({
      roomId: privateRoomId,
      name: 'Private Working Group',
      slug: 'private-working-group',
      description: 'members only',
      roomType: 'professional_domain',
      visibility: 'private',
      joinModel: 'request_approval',
      postingPolicy: 'all_members',
      storageMode: 'server',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    const privateStoryId = 'b0000000-0000-4000-8000-0000000000ff';
    await graph.ingestion.stories.createWithThread(
      {
        storyId: privateStoryId,
        canonicalUrl: null,
        title: 'Members-only working note',
        titleHash: `sim-private-${privateStoryId}`,
        submittedBy: '5f5e0000-0000-4000-8000-000000000001',
        sourceId: null,
        roomId: privateRoomId,
        visibility: 'room_only',
        mediaUploadRef: null,
        canonicalPublicStoryId: null,
        language: 'en',
        topicIds: [],
        proposedTopicIds: [],
        locationScope: null,
        sensitivityLabels: [],
        lifecycleState: 'gathering_attention',
        submissionType: 'original_brief',
        submissionMetadata: { submission_type: 'original_brief', body: 'members only' },
        excerpt: 'members only',
        publisher: null,
        author: null,
        publishedAt: null,
        mediaType: null,
        extractionState: 'not_applicable',
        hiddenState: null,
      },
      'b0000000-0000-4000-8000-0000000000fe',
    );
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'steady',
      seed: 'private',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 12; i += 1) await sim.tick();
    // No attention.aggregate event references the private story.
    const events = await graph.events.eventStore.listByTopicsBetween(
      ['attention.aggregate'],
      new Date(0).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    const touchedPrivate = events.some((e) => {
      const payload = e.payload as { items?: Array<{ story_id?: string }> };
      return (payload.items ?? []).some((it) => it.story_id === privateStoryId);
    });
    expect(touchedPrivate).toBe(false);
    // Sanity: the simulator DID generate attention (against public stories).
    expect(events.length).toBeGreaterThan(0);
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

  it('the influx scenario RETRIES a newcomer after a transient provisioning failure', async () => {
    const graph = await buildSimTestGraph();
    // The newcomer index advances only on success, so a transient createUser
    // failure must be retried on the SAME account (not skipped, which would let
    // the counter reach the cap while fewer real accounts exist).
    const newcomerIds = new Set(Array.from({ length: 12 }, (_, i) => newcomerSpec(i).userId));
    const failedOnce = new Set<string>();
    const realCreate = graph.identity.store.createUser.bind(graph.identity.store);
    graph.identity.store.createUser = async (...args) => {
      const userId = args[0].userId;
      // Fail the FIRST createUser for each newcomer (transient); succeed on retry.
      if (userId !== undefined && newcomerIds.has(userId) && !failedOnce.has(userId)) {
        failedOnce.add(userId);
        throw new Error('simulated transient store failure');
      }
      return realCreate(...args);
    };
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'influx',
      seed: 'newcomer-retry',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    for (let i = 0; i < 16; i += 1) await sim.tick();
    // At least one newcomer hit the transient failure, and EVERY such newcomer
    // was retried through to a real, provisioned account (no permanent skip).
    expect(failedOnce.size).toBeGreaterThan(0);
    for (const userId of failedOnce) {
      expect(await graph.identity.store.getUser(userId)).not.toBeNull();
    }
  });

  it('re-stamps a FRESH persona createdAt on a durable rerun (stays new for the anti-signal paths)', async () => {
    const graph = await buildSimTestGraph();
    const run1 = new DevTrafficSimulator({
      graph,
      scenario: 'coordinated_burst',
      seed: 'fresh',
      speed: 20,
      autoLoop: false,
    });
    await run1.start();
    await run1.tick(); // the burst provisions the fresh cluster
    run1.stop();
    const member = req(CLUSTER_ROSTER[0]).userId;
    expect(await graph.identity.store.getUser(member)).not.toBeNull();
    // Simulate the durable account having aged well past the coordination
    // new-account window, as a Postgres-backed dev DB would over time.
    const staleIso = new Date(graph.events.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await graph.identity.store.updateUser(member, { createdAt: staleIso });

    const run2 = new DevTrafficSimulator({
      graph,
      scenario: 'coordinated_burst',
      seed: 'fresh',
      speed: 20,
      autoLoop: false,
    });
    await run2.start();
    await run2.tick(); // re-provisions the SAME ids → re-stamps them fresh
    run2.stop();
    const refreshed = await graph.identity.store.getUser(member);
    // createdAt is recent again (well after the staled value), so the fresh-
    // account anti-signal + coordinated-report paths still see it as new.
    expect(Date.parse(req(refreshed).createdAt)).toBeGreaterThan(Date.parse(staleIso));
  });

  it('a restricted synthetic account cannot post content (mirrors the write-route guard)', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'steady',
      seed: 'restrict',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    // A moderation experiment restricts every provisioned persona. The simulator
    // calls submitStory/createContribution DIRECTLY (past the route middleware),
    // so without the account-state guard a restricted account would still post.
    for (const spec of BASE_ROSTER) {
      await graph.identity.store.updateUser(spec.userId, { accountState: 'restricted' });
    }
    for (let i = 0; i < 12; i += 1) await sim.tick();
    const after = sim.status();
    // No content lands from barred accounts (other steady tests prove an ACTIVE
    // roster does produce stories + comments, so 0 here is the guard biting).
    expect(after.counters.stories_submitted).toBe(0);
    expect(after.counters.comments_posted).toBe(0);
  });

  it('a suspended synthetic account generates no NEW attention or reports (mirrors authMiddleware)', async () => {
    const graph = await buildSimTestGraph();
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'steady',
      seed: 'suspend',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    // Active phase: create stories + accumulate reading so there IS content to
    // read/report in the suspended phase (avoids a vacuous pass).
    for (let i = 0; i < 4; i += 1) await sim.tick();
    // A moderation experiment suspends every persona — a state that cannot even
    // authenticate (unlike `restricted`, which may still read/report/upload).
    for (const spec of BASE_ROSTER) {
      await graph.identity.store.updateUser(spec.userId, { accountState: 'suspended' });
    }
    const att = sim.status().counters.attention_events_accepted;
    const rep = sim.status().counters.reports_filed;
    const joins = sim.status().counters.room_joins;
    for (let i = 0; i < 8; i += 1) await sim.tick();
    const after = sim.status();
    // Stories still exist to read, but every persona is now non-authenticable, so
    // the direct attention/report/join calls surface the same 403 a real client
    // gets — no new attention, reports, OR room subscriptions land.
    expect(after.counters.attention_events_accepted).toBe(att);
    expect(after.counters.reports_filed).toBe(rep);
    expect(after.counters.room_joins).toBe(joins);
  });

  it('backfills a platform passkey for an existing persona that lost its credential', async () => {
    const graph = await buildSimTestGraph();
    const run1 = new DevTrafficSimulator({
      graph,
      scenario: 'steady',
      seed: 'passkey',
      autoLoop: false,
    });
    await run1.start();
    run1.stop();
    const member = req(BASE_ROSTER[0]).userId;
    const creds = await graph.identity.store.listWebauthn(member);
    expect(creds.length).toBeGreaterThan(0);
    // Simulate a durable DB whose credential was cleaned up / predates the fix.
    for (const cred of creds) await graph.identity.store.deleteWebauthn(cred.credentialId);
    expect(await graph.identity.store.listWebauthn(member)).toHaveLength(0);
    // A second run re-provisions the SAME existing users and must backfill the
    // passkey so they stay verified (the verified-account routes depend on it).
    const run2 = new DevTrafficSimulator({
      graph,
      scenario: 'steady',
      seed: 'passkey',
      autoLoop: false,
    });
    await run2.start();
    run2.stop();
    expect((await graph.identity.store.listWebauthn(member)).length).toBeGreaterThan(0);
  });

  it('a stop()→start() during an in-flight tick abandons the stale plan (run-generation guard)', async () => {
    const graph = await buildSimTestGraph();
    // Park the very first #buildWorld so we can stop()+start() mid-tick.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realListRecent = graph.ingestion.stories.listRecent.bind(graph.ingestion.stories);
    let calls = 0;
    graph.ingestion.stories.listRecent = async (...args) => {
      calls += 1;
      if (calls === 1) await gate;
      return realListRecent(...args);
    };
    sim = new DevTrafficSimulator({
      graph,
      scenario: 'breaking_news',
      seed: 'gen',
      speed: 20,
      autoLoop: false,
    });
    await sim.start();
    const stale = sim.tick(); // enters #tickOnce (generation 1), parks in #buildWorld
    // Stop and restart while the old tick is parked — #running flips back to true,
    // but the run generation advances, so the parked tick must not resume its plan.
    sim.stop();
    await sim.start();
    release();
    await stale;
    // The superseded tick executed no actions (no breaking_news kickoff landed);
    // the new run has not ticked yet (autoLoop:false), so nothing was submitted.
    expect(sim.status().counters.stories_submitted).toBe(0);
  });

  it('rebinds SIM_STORY_META for a duplicate kickoff on a fresh-process rerun', async () => {
    const graph = await buildSimTestGraph();
    const run1 = new DevTrafficSimulator({
      graph,
      scenario: 'breaking_news',
      seed: 'meta',
      speed: 20,
      autoLoop: false,
    });
    await run1.start();
    // Several ticks so run1's serial range covers run2's first-tick serials —
    // every regenerated run2 story is then a duplicate, isolating the rebind.
    for (let i = 0; i < 3; i += 1) await run1.tick();
    run1.stop();
    // Simulate a FRESH PROCESS: the durable store keeps the stories, but the
    // in-memory SIM_STORY_META is empty.
    __resetSimStoryMetaForTest();
    expect(__simStoryMetaSizeForTest()).toBe(0);

    const run2 = new DevTrafficSimulator({
      graph,
      scenario: 'breaking_news',
      seed: 'meta',
      speed: 20,
      autoLoop: false,
    });
    await run2.start();
    await run2.tick(); // the kickoff regenerates the SAME url → duplicate_story
    run2.stop();
    // On a same-seed rerun every regenerated story is a duplicate, so the ONLY
    // way SIM_STORY_META gets repopulated is the duplicate-kickoff focus rebind —
    // which restores the focus story's domain so the repost gate can still fire.
    expect(__simStoryMetaSizeForTest()).toBeGreaterThanOrEqual(1);
  });

  it('a second same-seed run over a persistent store still produces NEW stories (no duplicate loop)', async () => {
    // A durable dev DB keeps a prior same-seed run's stories, so a replay
    // regenerates identical (deterministic) URLs that now already exist and are
    // rejected as duplicate_story. The run must burn the serial and move on
    // rather than loop on the same duplicate — here one persistent in-memory
    // graph stands in for that durable store across two simulator instances.
    const graph = await buildSimTestGraph();
    const run1 = new DevTrafficSimulator({
      graph,
      scenario: 'breaking_news',
      seed: 'persist',
      speed: 20,
      autoLoop: false,
    });
    await run1.start();
    for (let i = 0; i < 3; i += 1) await run1.tick();
    run1.stop();
    const afterRun1 = (await graph.ingestion.stories.listRecent(200)).length;
    expect(afterRun1).toBeGreaterThan(0);

    const run2 = new DevTrafficSimulator({
      graph,
      scenario: 'breaking_news',
      seed: 'persist',
      speed: 20,
      autoLoop: false,
    });
    await run2.start();
    for (let i = 0; i < 12; i += 1) await run2.tick();
    run2.stop();
    // The replay cleared the prior serial range and landed fresh stories instead
    // of spinning on the duplicate kickoff (which would leave the count flat).
    const afterRun2 = (await graph.ingestion.stories.listRecent(400)).length;
    expect(afterRun2).toBeGreaterThan(afterRun1);
    expect(run2.status().counters.stories_submitted).toBeGreaterThan(0);
  });

  it('a long mixed run moves the high-frequency counters and produces varied submission types', async () => {
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
    // Over a long steady run, at least one room join lands. (Reports are a
    // low-frequency organic action; the coordinated_burst test covers them.)
    expect(c.room_joins).toBeGreaterThan(0);
    // The corpus carries more than one submission type (link/brief/question/local).
    const types = new Set(
      (await graph.ingestion.stories.listRecent(200)).map((s) => s.submissionType),
    );
    expect(types.size).toBeGreaterThan(1);
    expect(types.has('link')).toBe(true);
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

describe('consumedDebateChances (cap-aware one-shot accounting)', () => {
  const world = (over: Partial<Pick<SimWorld, 'openDebates' | 'judgedDebates'>>): SimWorld => ({
    stories: [],
    rooms: [],
    commentsByStory: new Map(),
    recentTitles: new Set(),
    focusStoryId: null,
    storyCapReached: false,
    openDebates: [],
    judgedDebates: [],
    ...over,
  });
  const openArena = (
    debateId: string,
    reinforceEligible = true,
  ): SimWorld['openDebates'][number] => ({
    debateId,
    incumbentUserId: 'u-inc',
    incumbentPosted: true,
    incumbentWillRebut: true,
    domain: 'health',
    challengerUserId: 'u-chal',
    challengerSummary: 'The stated figure does not match the primary series.',
    challengerCitationUrls: ['https://daily-ledger.example/refs/x-0'],
    reinforceEligible,
  });
  const overrideAction = (debateId: string): SimAction => ({
    kind: 'debate_override',
    personaUserId: 'u-steward',
    debateId,
    winner: 'incumbent',
    reason: 'The adjudicator under-weighted the primary registry both sides cite.',
  });
  const positionAction = (debateId: string, side: 'incumbent' | 'challenger'): SimAction => ({
    kind: 'debate_position',
    personaUserId: 'u',
    debateId,
    side,
    summary: 'A substantive position summary for the arena in question.',
    citationUrls: ['https://civic-wire.example/refs/x-0'],
  });
  const filler = (): SimAction => ({ kind: 'join_room', personaUserId: 'u', roomId: 'r' });
  const saturate = (actions: SimAction[]): SimAction[] => {
    while (actions.length < MAX_ACTIONS_PER_TICK) actions.push(filler());
    return actions;
  };

  it('an UNSATURATED plan consumes every offered chance (absence proves a declined roll)', () => {
    const w = world({
      openDebates: [openArena('d-r')],
      judgedDebates: [{ debateId: 'd-o', roomId: 'r1', winner: 'challenger' }],
    });
    const consumed = consumedDebateChances(w, [filler()]);
    expect(consumed.reinforce.has('d-r')).toBe(true);
    expect(consumed.override.has('d-o')).toBe(true);
  });

  it('a SATURATED plan does NOT consume a chance whose action is absent (may have been truncated)', () => {
    const w = world({
      openDebates: [openArena('d-r')],
      judgedDebates: [{ debateId: 'd-o', roomId: 'r1', winner: 'challenger' }],
    });
    const consumed = consumedDebateChances(w, saturate([]));
    expect(consumed.reinforce.has('d-r')).toBe(false);
    expect(consumed.override.has('d-o')).toBe(false);
  });

  it('a SATURATED plan still consumes the chances whose actions survived into it', () => {
    const w = world({
      openDebates: [openArena('d-r')],
      judgedDebates: [
        { debateId: 'd-o', roomId: 'r1', winner: 'challenger' },
        { debateId: 'd-cut', roomId: 'r1', winner: 'incumbent' },
      ],
    });
    const consumed = consumedDebateChances(
      w,
      saturate([positionAction('d-r', 'challenger'), overrideAction('d-o')]),
    );
    expect(consumed.reinforce.has('d-r')).toBe(true);
    expect(consumed.override.has('d-o')).toBe(true);
    expect(consumed.override.has('d-cut')).toBe(false); // re-offers next tick
  });

  it('an incumbent rebuttal never consumes the challenger reinforcement chance', () => {
    const w = world({ openDebates: [openArena('d-r')] });
    const consumed = consumedDebateChances(w, saturate([positionAction('d-r', 'incumbent')]));
    expect(consumed.reinforce.has('d-r')).toBe(false);
  });

  it('a non-eligible open arena is never listed as consumed', () => {
    const w = world({ openDebates: [openArena('d-quiet', false)] });
    const consumed = consumedDebateChances(w, [filler()]);
    expect(consumed.reinforce.size).toBe(0);
  });
});

describe('governed-room verdict TTL (live governance changes redirect the bias)', () => {
  it('re-reads agentOperative after the TTL, so a mid-run freeze/re-admission is picked up', async () => {
    const base = await buildSimTestGraph();
    let operative = false;
    let reads = 0;
    const graph = {
      ...base,
      governance: {
        agentOperative: async () => {
          reads += 1;
          return operative;
        },
      },
    };
    // Drive the runtime's clock through the events container (its #now()).
    const realNow = base.events.now;
    let offsetMs = 0;
    graph.events.now = () => realNow() + offsetMs;

    const sim = new DevTrafficSimulator({ graph, scenario: 'quiet', seed: 'ttl', autoLoop: false });
    try {
      await sim.start();
      await sim.tick(); // world build #1 → one read per world room
      const readsAfterFirst = reads;
      expect(readsAfterFirst).toBeGreaterThan(0);
      await sim.tick(); // within the TTL → served from cache
      expect(reads).toBe(readsAfterFirst);

      operative = true; // a LIVE governance change (e.g. re-admission)
      offsetMs = ROOM_GOVERNED_TTL_MS + 1_000; // move past the TTL
      await sim.tick(); // world build re-reads and sees the change
      expect(reads).toBeGreaterThan(readsAfterFirst);
    } finally {
      sim.stop();
      graph.events.now = realNow;
    }
  });
});

describe('pulse metric baselining (boot noise never reads as simulator activity)', () => {
  // Deliberately LAST in this file: it binds the process ai-governance
  // singleton, which stays bound for the rest of the worker.
  it('construction snapshots the process-wide counters; the pulses report deltas', async () => {
    const graph = await buildSimTestGraph();
    const aiGov = createInMemoryAiGovernanceServices(graph.events);
    setAiGovernanceServices(aiGov);
    // Boot-time noise BEFORE the simulator exists: the WS-K admission-gate
    // probes and the seeded sample agent action increment the very counters
    // the pulses read (observed live: 13 proposals at boot).
    aiGov.metrics.increment('ai.governance.moderation.decided', 13);
    aiGov.metrics.increment('ai.governance.moderation.proposed.remove', 6);
    aiGov.metrics.increment('ai.governance.debate.llm.decided', 2);
    graph.forum.metrics.increment('contributions.agent_moderated', 3);

    const sim = new DevTrafficSimulator({
      graph,
      scenario: 'steady',
      seed: 'baseline',
      autoLoop: false,
    });
    // An IDLE simulator reads zero — never the boot's counters.
    let status = sim.status();
    expect(status.moderation_pulse.proposals).toBe(0);
    expect(status.moderation_pulse.proposed.remove).toBe(0);
    expect(status.moderation_pulse.agent_escalations).toBe(0);
    expect(status.debate_pulse.llm_decided).toBe(0);

    // Activity AFTER construction is reported as the delta.
    aiGov.metrics.increment('ai.governance.moderation.decided', 2);
    aiGov.metrics.increment('ai.governance.moderation.proposed.remove', 1);
    graph.forum.metrics.increment('contributions.agent_moderated', 1);
    status = sim.status();
    expect(status.moderation_pulse.proposals).toBe(2);
    expect(status.moderation_pulse.proposed.remove).toBe(1);
    expect(status.moderation_pulse.agent_escalations).toBe(1);
    expect(status.debate_pulse.llm_decided).toBe(0);
  });
});
