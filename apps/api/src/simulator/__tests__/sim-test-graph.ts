// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Builds a faithful in-memory service graph for the simulator integration
// tests: the same six-container wiring the dev boot uses (identity → events →
// ingestion → forum → invariants → ranking) PLUS moderation, with all the WS-E
// router consumers registered, and the simulator link-fixtures fetcher so
// synthetic `.example` link stories extract. Everything is in-memory; no
// Postgres, no Redis, no schedulers, no real timers.

import { TEST_IDENTITY_CONFIG } from '../../__tests__/event-test-helpers.js';
import { registerDefaultConsumers } from '../../events/consumers.js';
import { createInMemoryEventPipelineServices } from '../../events/services.js';
import { createInMemoryForumServices, registerForumConsumers } from '../../forum/services.js';
import { createInMemoryIdentityServices } from '../../identity/services.js';
import {
  createInMemoryIngestionServices,
  registerIngestionConsumers,
} from '../../ingestion/services.js';
import {
  createInMemoryInvariantServices,
  registerInvariantConsumers,
} from '../../invariants/services.js';
import { createInMemoryModerationServices } from '../../moderation/services.js';
import {
  createInMemoryRankingServices,
  refreshStoryFeatures,
  registerRankingConsumers,
} from '../../ranking/services.js';
import { createSimulatorFetchDocument } from '../link-fixtures.js';
import type { SimulatorServiceGraph } from '../runtime.js';

/** A few public, open, server-storage rooms across the simulator's content
 *  domains, so synthetic stories have somewhere to land beyond the Commons. */
const SIM_TEST_ROOMS = [
  { id: 'a0000000-0000-4000-8000-000000000001', name: 'Public Health', domain: 'health' },
  { id: 'a0000000-0000-4000-8000-000000000002', name: 'Climate & Energy', domain: 'climate' },
  { id: 'a0000000-0000-4000-8000-000000000003', name: 'Riverside Local', domain: 'local' },
  { id: 'a0000000-0000-4000-8000-000000000004', name: 'Elections Desk', domain: 'elections' },
] as const;

export async function buildSimTestGraph(): Promise<SimulatorServiceGraph> {
  const identity = createInMemoryIdentityServices(TEST_IDENTITY_CONFIG);
  const events = createInMemoryEventPipelineServices({
    storyTitle: () => null,
  });
  registerDefaultConsumers(events);
  const ingestion = createInMemoryIngestionServices({
    events,
    skipAccountAgeGate: true,
    fetchDocument: createSimulatorFetchDocument(),
    // Generous submission budget so a fast test does not trip the per-account
    // limiter before it has exercised the happy path (the limiter itself is
    // covered by its own tests + the runtime's honest rejection tally).
    config: { submissionPerHour: 1000, submissionPerDay: 10000 },
  });
  await ingestion.reloadConfig();
  registerIngestionConsumers(events, ingestion);
  const forum = createInMemoryForumServices({
    events,
    ingestion,
    config: { contributionsPerMinute: 120, contributionsPerHour: 5000 },
  });
  await forum.reloadConfig();
  registerForumConsumers(events, ingestion, forum);
  const invariants = createInMemoryInvariantServices(events, identity, ingestion, forum);
  await invariants.reloadConfig();
  registerInvariantConsumers(events, ingestion, identity, invariants);
  const ranking = createInMemoryRankingServices(events, identity, ingestion, forum, invariants);
  await ranking.reloadConfig();
  registerRankingConsumers(ranking);
  const moderation = createInMemoryModerationServices();
  await moderation.reloadConfig();

  // Seed the extra public rooms (the Commons self-seeds in the room store).
  for (const room of SIM_TEST_ROOMS) {
    await forum.rooms.insert({
      roomId: room.id,
      name: room.name,
      slug: room.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      description: `${room.name} — a public simulator test room.`,
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      storageMode: 'server',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
  }

  return {
    identity,
    events,
    ingestion,
    forum,
    invariants,
    ranking,
    moderation,
    // No governed rooms in the default test graph (a test that wants the
    // governed-room placement bias swaps in its own reader).
    governance: { agentOperative: async () => false },
  };
}

/** Force one story's ranking features to refresh (used to assert the feed
 *  reacts to accumulated signals). */
export async function refreshFeatures(
  graph: SimulatorServiceGraph,
  storyId: string,
): Promise<void> {
  await refreshStoryFeatures(graph.ranking, storyId);
}
