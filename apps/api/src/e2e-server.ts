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
import { accountMayHoldSession } from '@licio/shared';
import { validateServerEnv } from '@licio/shared/env';
import { Hono } from 'hono';
import { seedAiGovernance } from './ai-governance/seed.js';
import {
  createInMemoryAiGovernanceServices,
  setAiGovernanceServices,
} from './ai-governance/services.js';
import { registerAiGovernanceConsumers } from './ai-governance/wiring.js';
import { createApp } from './app.js';
import {
  buildComplianceExport,
  buildCompliancePort,
  buildCompliancePurge,
  complianceServicesConfigured,
  createInMemoryComplianceServices,
  getComplianceServices,
  resolveRegionForUser,
  setComplianceServices,
} from './compliance/services.js';
import { registerDefaultConsumers } from './events/consumers.js';
import {
  createInMemoryEventPipelineServices,
  setEventPipelineServices,
} from './events/services.js';
import { buildDebateJudgeRunner } from './forum/debate-scheduler.js';
import {
  createInMemoryForumServices,
  registerForumConsumers,
  setForumServices,
} from './forum/services.js';
import { buildAuthorHistoryReader, createRoomAgentModerator } from './governance/forum-agent.js';
import {
  createGovernanceService,
  getGovernanceService,
  setGovernanceService,
} from './governance/services.js';
import { createInMemoryGovernanceStores } from './governance/stores.js';
import { accountRef } from './identity/crypto.js';
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
import { storeKnomosisConfigValue } from './knomosis/config.js';
import { exportFinancialWalletData, purgeFinancialWalletData } from './knomosis/data-rights.js';
import { FakeKnomosisGateway } from './knomosis/gateway.js';
import { createInMemoryKnomosisServices, setKnomosisServices } from './knomosis/services.js';
import {
  buildLawPackPort,
  buildRegionResolver,
  buildRoomGovernancePort,
  buildRoomModePort,
  syncPinnedDeployments,
} from './knomosis/wiring.js';
import { LcapIngestServer } from './lcap/server-ingest.js';
import { setLcapIngestServer } from './lcap/service.js';
import { InMemoryLcapServerStore } from './lcap/store.js';
import { demoStory } from './lib/demo-data.js';
import { seedForumDemoData } from './lib/demo-seed.js';
import { createLogger } from './lib/logger.js';
import { notFoundHandler } from './middleware/error-handler.js';
import { RendezvousService, setRendezvousService } from './private-rendezvous/service.js';
import { InMemoryRendezvousStore } from './private-rendezvous/stores.js';
import {
  createInMemoryRankingServices,
  refreshStoryFeatures,
  registerRankingConsumers,
  setRankingServices,
} from './ranking/services.js';
import { createTestAuthRoute } from './routes/test-auth.js';
import { createTestWalletRoute } from './routes/test-wallet.js';
import { buildWsmReadinessChecklistPort } from './treasury/readiness.js';
import {
  buildMembershipFactsPort,
  buildStewardElectionPort,
  buildTreasuryExecutorPort,
  createInMemoryTreasuryServices,
  setTreasuryServices,
} from './treasury/services.js';

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

// The WS-E fold's thread → story fallback (see `storyIdForThread` on
// `EventPipelineServices`).  Assigned AFTER the ingestion container exists, like
// the story-title cache above: `eventServices` is built first, and the resolution
// belongs to the story store.
eventServices.storyIdForThread = (threadId) =>
  ingestionServices.stories.getStoryIdByThreadId(threadId);

const forumServices = createInMemoryForumServices({
  events: eventServices,
  ingestion: ingestionServices,
  log: (event, meta) => logger.info(meta, event),
});
await forumServices.reloadConfig();
// The WS-Q read bar's platform-ADMIN arm (mirrors the production boot wiring,
// incl. the active-account gate).
forumServices.platformRolesReader = async (id) => {
  const user = await identityServices.store.getUser(id);
  return accountMayHoldSession(user?.accountState) ? (user?.roles ?? []) : [];
};
// WS-T challenge policy — the KYC capacity-boost reader (mirrors the
// production boot: lazy compliance resolution, fail-closed to false).
forumServices.kycReader = async (userId) => {
  if (!complianceServicesConfigured()) return false;
  try {
    return (await getComplianceServices().kycLevel(userId)) === 'kyc_partner';
  } catch {
    return false;
  }
};
// WS-U: the contribution path consults the in-room agent (uses the lazy
// in-memory GovernanceService singleton in the harness), with real author-history
// signals over the harness's in-memory stores.
forumServices.agentModerator = createRoomAgentModerator({
  readAuthorHistory: buildAuthorHistoryReader({
    getUser: (id) => identityServices.store.getUser(id),
    getSubscription: (roomId, id) => forumServices.rooms.getSubscription(roomId, id),
    stewardRolesFor: (roomId, id) => forumServices.rooms.stewardRolesFor(roomId, id),
    listUserContributions: (id, limit) => forumServices.contributions.listByUser(id, null, limit),
    getThreadRoomId: async (threadId) =>
      (await ingestionServices.stories.getThreadById(threadId))?.roomId ?? null,
    now: () => Date.now(),
  }),
});
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
registerInvariantConsumers(eventServices, ingestionServices, invariantServices);

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
registerAiGovernanceConsumers(eventServices, aiGovernanceServices, (storyId) =>
  refreshStoryFeatures(rankingServices, storyId),
);
// WS-T: judge debate arenas through the REAL guard → (LLM leg, if wired) → MLP
// fallback chain, exactly as the production boot does (index.ts) — so the
// seeded dispute showcase and any correction filed in the harness resolve to a
// genuine adjudicator verdict, never the fail-closed inconclusive default.
forumServices.debateJudge = buildDebateJudgeRunner(forumServices.now);

// WS-S.6.6 — force the IN-MEMORY server-blind rendezvous store.  The harness sets a DUMMY
// DATABASE_URL to satisfy the env validator, but `getRendezvousService()`'s `buildStore()` keys off
// DATABASE_URL and would otherwise pick the Drizzle adapter and try to reach the non-existent DB host
// (500s on the first announce).  Overriding here keeps the rendezvous truly in-memory, like every
// other harness service, so the two-browser private-room E2E signals over a working endpoint.
setRendezvousService(new RendezvousService(new InMemoryRendezvousStore()));

// WS-R.12 — same dummy-DATABASE_URL hazard for the LCAP ingestion server: `getLcapIngestServer()`
// would otherwise bind the Drizzle store and 500 on the service worker's background C0-sync `/pulse`.
// Force the in-memory adapter so the LCAP surfaces work in the harness too.
setLcapIngestServer(
  new LcapIngestServer(
    process.env['LCAP_NETWORK_ID'] ?? 'licio',
    () => Date.now(),
    new InMemoryLcapServerStore(),
  ),
);

// WS-L knomosis: the in-memory container with the deterministic FAKE gateway,
// the forum-backed room ports, and the pinned local deployment.  The harness
// EXPLICITLY enables the crypto/governance flags (they default off everywhere
// else) so the wallet + governance-simulation BFF specs exercise real flows.
const knomosisServices = createInMemoryKnomosisServices({
  configStore: eventServices.configStore,
  ephemeral: identityServices.challenges,
  audit: identityServices.audit,
  masterSecret: identityServices.config.masterSecret,
  siweBase: {
    domain: identityServices.config.siwe.domain,
    uri: identityServices.config.siwe.uri,
  },
  gateway: new FakeKnomosisGateway(),
  log: (event, meta) => logger.info(meta, event),
});
knomosisServices.rooms = buildRoomGovernancePort(forumServices, identityServices);
knomosisServices.roomMode = buildRoomModePort(forumServices);
// Pure LOCALE resolver; `regionResolver` is replaced with the authoritative
// ladder once compliance is wired (see below).  The compliance `localeRegion`
// captures THIS const so the ladder is not self-referential.
const localeRegionResolver = buildRegionResolver(identityServices);
knomosisServices.regionResolver = localeRegionResolver;
identityServices.exportFinancialWallets = (userId) =>
  exportFinancialWalletData(knomosisServices, userId);
identityServices.purgeFinancialWallets = (userId) =>
  purgeFinancialWalletData(knomosisServices, userId);
await storeKnomosisConfigValue(eventServices.configStore, 'cryptoEnabled', true);
await storeKnomosisConfigValue(eventServices.configStore, 'governanceEnabled', true);
await knomosisServices.reloadConfig();
await syncPinnedDeployments(knomosisServices);
setKnomosisServices(knomosisServices);
eventServices.cryptoFlagEnabled = () => knomosisServices.config().cryptoEnabled;

// WS-N compliance: the in-memory container + the production CompliancePort,
// wired exactly like the production boot (identical closures over the
// in-memory siblings) so the BFF-in-the-loop flows exercise the REAL
// availability/region/disclosure surfaces.
const complianceServices = createInMemoryComplianceServices({
  configStore: eventServices.configStore,
  log: (event, meta) => logger.info(meta, event),
});
complianceServices.localeRegion = (userId) => localeRegionResolver.regionForUser(userId);
complianceServices.ageBand = async (userId) =>
  (await identityServices.store.getUser(userId))?.ageBand ?? null;
complianceServices.knomosisFlags = () => ({
  cryptoEnabled: knomosisServices.config().cryptoEnabled,
  governanceEnabled: knomosisServices.config().governanceEnabled,
});
complianceServices.roomStorageMode = async (roomId) =>
  (await forumServices.rooms.getById(roomId))?.storageMode ?? null;
complianceServices.walletOwner = async (walletAccountId) =>
  (await knomosisServices.wallets.getById(walletAccountId))?.userId ?? null;
complianceServices.opaqueRef = (id) => accountRef(identityServices.config.masterSecret, id);
await complianceServices.reloadConfig();
setComplianceServices(complianceServices);
knomosisServices.compliance = buildCompliancePort(complianceServices);
// The kill-switch region seam resolves the AUTHORITATIVE ladder region (verified
// declaration → locale), matching production — a verified-region member is caught
// by that region's pause regardless of locale.  `localeRegion` above uses the pure
// `localeRegionResolver`, so this is not self-referential.
knomosisServices.regionResolver = {
  regionForUser: async (userId) => (await resolveRegionForUser(complianceServices, userId)).region,
};
identityServices.exportComplianceData = buildComplianceExport(complianceServices);
identityServices.purgeCompliance = buildCompliancePurge(complianceServices, async (userId) =>
  (await knomosisServices.wallets.listByUser(userId, true)).map((w) => w.walletAccountId),
);

// WS-U + WS-M: bind the governance service to EXPLICIT in-memory stores (so the
// treasury container can share them) and wire the WS-M container exactly like
// the production boot — real readiness evaluators, the shipped fail-closed
// treasury executor, forced rotation elections.
const governanceStores = createInMemoryGovernanceStores();
setGovernanceService(
  createGovernanceService({
    stores: governanceStores,
    cryptoFlag: () => knomosisServices.config().cryptoEnabled,
  }),
);
knomosisServices.lawPacks = buildLawPackPort(governanceStores);
const treasuryServices = createInMemoryTreasuryServices({
  knomosis: knomosisServices,
  governanceStores,
  membership: buildMembershipFactsPort(forumServices, identityServices, knomosisServices),
  treasuryExecutor: buildTreasuryExecutorPort(getGovernanceService()),
  elections: buildStewardElectionPort(getGovernanceService(), (roomId) =>
    // ONE measurement reporting the count AND its instant: the election records
    // that instant as its open, and `castElectionVote` compares a voter's join
    // against it.
    forumServices.rooms.measureEligibleVoters(roomId),
  ),
});
setTreasuryServices(treasuryServices);
knomosisServices.readinessChecklist = buildWsmReadinessChecklistPort(treasuryServices);

await seedForumDemoData(forumServices, ingestionServices, identityServices.store);
await seedAiGovernance(aiGovernanceServices);

// --- App: the test-auth route first (no CSRF — it bootstraps the session),
// then the full production app for everything else. --------------------------
// `notFound` on the WRAPPER too — see the note in `index.ts`: an unmatched path
// reaches this instance, not the mounted app, and Hono's default is plain text.
const app = new Hono()
  .notFound(notFoundHandler)
  .route('/v1/test-auth', createTestAuthRoute(identityServices))
  // Test-only fixture signer (never in the production AppType): the Playwright
  // fake EIP-6963 provider proxies its sign requests here so the browser
  // drives REAL secp256k1 signatures through the REAL verification path.
  .route('/v1/test-wallet', createTestWalletRoute())
  .route('/', createApp());

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.warn(
    { port: info.port },
    'E2E in-memory server started with the TEST-ONLY auth route (never run this in production).',
  );
});
