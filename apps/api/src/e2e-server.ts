// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory BFF server for the Playwright E2E harness (WS-P seed). It runs the
// FULL production request/response stack (the real app + middleware + the eight
// WS-I feed stages) over IN-MEMORY stores only — no Postgres, no Redis, no
// background schedulers — seeded with the demo dataset (public + private rooms,
// a steward/member demo user, public + room_only stories). A test-only auth
// route (mounted here, never in the production app) mints a real session cookie
// so the browser can drive authenticated WS-Q flows.
//
// SECURITY: this entry refuses to start under NODE_ENV=production and requires
// LICIO_E2E=1. It is NEVER the production server (that is src/index.ts), so the
// test-auth route cannot be a production backdoor.
import { serve } from '@hono/node-server';
import { validateServerEnv } from '@licio/shared/env';
import { Hono } from 'hono';
import { seedAiGovernance } from './ai-governance/seed.js';
import {
  createInMemoryAiGovernanceServices,
  setAiGovernanceServices,
} from './ai-governance/services.js';
import { registerAiGovernanceConsumers } from './ai-governance/wiring.js';
import { createApp } from './app.js';
import { registerDefaultConsumers } from './events/consumers.js';
import {
  createInMemoryEventPipelineServices,
  setEventPipelineServices,
} from './events/services.js';
import {
  createInMemoryForumServices,
  registerForumConsumers,
  setForumServices,
} from './forum/services.js';
import { createRoomAgentModerator } from './governance/forum-agent.js';
import { buildIdentityServicesFromEnv, setIdentityServices } from './identity/services.js';
import {
  createInMemoryIngestionServices,
  registerIngestionConsumers,
  setIngestionServices,
} from './ingestion/services.js';
import {
  createInMemoryInvariantServices,
  registerInvariantConsumers,
  setInvariantServices,
} from './invariants/services.js';
import { demoStory } from './lib/demo-data.js';
import { seedForumDemoData } from './lib/demo-seed.js';
import { createLogger } from './lib/logger.js';
import {
  createInMemoryRankingServices,
  registerRankingConsumers,
  setRankingServices,
} from './ranking/services.js';
import { createTestAuthRoute } from './routes/test-auth.js';

const env = validateServerEnv(process.env);

if (env.NODE_ENV === 'production') {
  throw new Error('e2e-server must NOT run in production (it mounts a test-only auth route).');
}
if (process.env['LICIO_E2E'] !== '1') {
  throw new Error('Refusing to start: set LICIO_E2E=1 to run the E2E harness server.');
}

const logger = createLogger(env.LOG_LEVEL);

// --- In-memory service graph (the same wiring as src/index.ts, minus every
// Drizzle/Redis adapter, scheduler, and recovery pass). ----------------------
const identityServices = buildIdentityServicesFromEnv(env);

const storyTitleCache = new Map<string, string>();
const eventServices = createInMemoryEventPipelineServices({
  limits: { perMinute: env.EVENTS_RATE_PER_MINUTE, perHour: env.EVENTS_RATE_PER_HOUR },
  storyTitle: (storyId) => storyTitleCache.get(storyId) ?? demoStory(storyId)?.title ?? null,
  log: (event, meta) => logger.info(meta, event),
});
registerDefaultConsumers(eventServices);
setEventPipelineServices(eventServices);

const ingestionServices = createInMemoryIngestionServices({
  events: eventServices,
  // Same dev/test allowlist as src/index.ts: drop the account-age submission
  // gate so freshly created accounts can post in the E2E harness. This entry
  // already refuses NODE_ENV=production above, so the flag is never production.
  skipAccountAgeGate: env.NODE_ENV === 'development' || env.NODE_ENV === 'test',
  log: (event, meta) => logger.info(meta, event),
});
await ingestionServices.reloadConfig();
registerIngestionConsumers(eventServices, ingestionServices);
setIngestionServices(ingestionServices);

const forumServices = createInMemoryForumServices({
  events: eventServices,
  ingestion: ingestionServices,
  log: (event, meta) => logger.info(meta, event),
});
await forumServices.reloadConfig();
// WS-U: the contribution path consults the in-room agent (uses the lazy
// in-memory GovernanceService singleton in the harness).
forumServices.agentModerator = createRoomAgentModerator();
setForumServices(forumServices);
registerForumConsumers(eventServices, ingestionServices, forumServices);

const invariantServices = createInMemoryInvariantServices(
  eventServices,
  identityServices,
  ingestionServices,
  forumServices,
  { log: (event, meta) => logger.info(meta, event) },
);
await invariantServices.reloadConfig();
setInvariantServices(invariantServices);
registerInvariantConsumers(eventServices, ingestionServices, identityServices, invariantServices);

const rankingServices = createInMemoryRankingServices(
  eventServices,
  identityServices,
  ingestionServices,
  forumServices,
  invariantServices,
  { log: (event, meta) => logger.info(meta, event) },
);
await rankingServices.reloadConfig();
registerRankingConsumers(rankingServices);
setRankingServices(rankingServices);

// Keep the Signal Ledger title cache warm as stories are created/read.
{
  const baseGetById = ingestionServices.stories.getById.bind(ingestionServices.stories);
  ingestionServices.stories.getById = async (storyId: string) => {
    const story = await baseGetById(storyId);
    if (story) storyTitleCache.set(story.storyId, story.title);
    return story;
  };
}
setIdentityServices(identityServices);

// WS-K AI & model governance: register + deploy the governed models through the
// real gate and seed the inventory/lineage, so the governance surfaces work in
// the BFF harness.
const aiGovernanceServices = createInMemoryAiGovernanceServices(eventServices, {
  log: (event, meta) => logger.info(meta, event),
});
aiGovernanceServices.ingestion = ingestionServices;
aiGovernanceServices.forum = forumServices;
await aiGovernanceServices.reloadConfig();
setAiGovernanceServices(aiGovernanceServices);
registerAiGovernanceConsumers(eventServices, aiGovernanceServices);

await seedForumDemoData(forumServices, ingestionServices, identityServices.store);
await seedAiGovernance(aiGovernanceServices);

// --- App: the test-auth route first (no CSRF — it bootstraps the session),
// then the full production app for everything else. --------------------------
const app = new Hono()
  .route('/v1/test-auth', createTestAuthRoute(identityServices))
  .route('/', createApp());

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.warn(
    { port: info.port },
    'E2E in-memory server started with the TEST-ONLY auth route (never run this in production).',
  );
});
