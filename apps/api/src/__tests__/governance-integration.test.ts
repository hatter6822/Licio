// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-U governance Drizzle adapters
// — the same interfaces the in-memory adapters satisfy, against the REAL
// migration chain (incl. 0035's isolated `knomosis` bounded context and 0036's
// vote composite PK + model `(room, digest)` unique index). Run when DATABASE_URL
// is set (the CI test job provisions the service container).
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test

import { randomUUID } from 'node:crypto';
import {
  agentActionLogs,
  agentTreasuryActions,
  createDbClient,
  migrationsFolder,
  modelRatifications,
  roomAgentBindings,
  roomGovernanceModels,
  roomGovernancePrompts,
  roomLawPacks,
  roomPendingRemoderations,
  roomStewardSeats,
  stewardElections,
  users,
} from '@licio/db';
import type { GovernancePolicyBundle, Verdict } from '@licio/governance';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrizzleAgentActionStore,
  DrizzleBindingStore,
  DrizzleElectionStore,
  DrizzleLawPackStore,
  DrizzleModelStore,
  DrizzlePendingRemoderationStore,
  DrizzlePromptStore,
  DrizzleRatificationBallotStore,
  DrizzleRatificationVoteStore,
  DrizzleSeatStore,
  DrizzleTreasuryActionStore,
  DrizzleVoteStore,
} from '../governance/drizzle-governance-stores.js';
import { defaultModerationLawPack } from '../governance/service.js';

const DB_URL = process.env['DATABASE_URL'];
type Db = ReturnType<typeof createDbClient>;

function bundleOf(): GovernancePolicyBundle {
  return {
    bundleId: 'civility',
    version: '1',
    name: 'Civility',
    moderationPrompt:
      'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
    promptTemplates: { summary: 'Be brief.' },
    config: { summaryStyle: 'neutral_brief', explanationVerbosity: 'standard' },
    requestedCapabilities: ['moderate.flag'],
  };
}

async function makeUser(db: Db, handle: string): Promise<string> {
  const inserted = await db
    .insert(users)
    .values({
      handle: `${handle}_${randomUUID().slice(0, 8)}`,
      displayName: 'WS-U Integration',
      email: null,
      ageBandIfKnown: 'adult',
      privacySettings: defaultPrivacySettings(),
      personalizationSettings: defaultPersonalizationSettings(),
      reputationSummaryPrivate: emptyReputationSummary(),
    })
    .returning();
  return (inserted[0] as { userId: string }).userId;
}

describe.skipIf(!DB_URL)('WS-U governance Drizzle adapters (live Postgres)', () => {
  let db: Db;
  const roomId = randomUUID();
  let voterId: string;
  let candidateId: string;
  let stewardId: string;

  let seats: DrizzleSeatStore;
  let elections: DrizzleElectionStore;
  let votes: DrizzleVoteStore;
  let models: DrizzleModelStore;
  let prompts: DrizzlePromptStore;
  let lawPacks: DrizzleLawPackStore;
  let bindings: DrizzleBindingStore;
  let agentActions: DrizzleAgentActionStore;
  let treasury: DrizzleTreasuryActionStore;
  let ratifications: DrizzleRatificationVoteStore;
  let ratificationBallots: DrizzleRatificationBallotStore;
  let pendingRemoderation: DrizzlePendingRemoderationStore;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    seats = new DrizzleSeatStore(db);
    elections = new DrizzleElectionStore(db);
    votes = new DrizzleVoteStore(db);
    models = new DrizzleModelStore(db);
    prompts = new DrizzlePromptStore(db);
    lawPacks = new DrizzleLawPackStore(db);
    bindings = new DrizzleBindingStore(db);
    agentActions = new DrizzleAgentActionStore(db);
    treasury = new DrizzleTreasuryActionStore(db);
    ratifications = new DrizzleRatificationVoteStore(db);
    ratificationBallots = new DrizzleRatificationBallotStore(db);
    pendingRemoderation = new DrizzlePendingRemoderationStore(db);
    voterId = await makeUser(db, 'wsu_voter');
    candidateId = await makeUser(db, 'wsu_cand');
    stewardId = await makeUser(db, 'wsu_stew');
  });

  afterAll(async () => {
    // FK-safe order: bindings (restrict→model) before models; elections cascade votes;
    // ratification ballots cascade from the vote, votes before models.
    await db.delete(agentTreasuryActions).where(eq(agentTreasuryActions.roomId, roomId));
    await db.delete(roomPendingRemoderations).where(eq(roomPendingRemoderations.roomId, roomId));
    await db.delete(agentActionLogs).where(eq(agentActionLogs.roomId, roomId));
    await db.delete(roomAgentBindings).where(eq(roomAgentBindings.roomId, roomId));
    await db.delete(modelRatifications).where(eq(modelRatifications.roomId, roomId));
    await db.delete(roomGovernancePrompts).where(eq(roomGovernancePrompts.roomId, roomId));
    await db.delete(roomGovernanceModels).where(eq(roomGovernanceModels.roomId, roomId));
    await db.delete(stewardElections).where(eq(stewardElections.roomId, roomId));
    await db.delete(roomStewardSeats).where(eq(roomStewardSeats.roomId, roomId));
    await db.delete(roomLawPacks).where(eq(roomLawPacks.roomId, roomId));
    for (const id of [voterId, candidateId, stewardId]) {
      await db.delete(users).where(eq(users.userId, id));
    }
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  it('upserts + reads the steward seat in place', async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 1_000).toISOString();
    await seats.put({
      roomId,
      holderUserId: stewardId,
      termStart: now,
      termEnd: end,
      bootstrap: true,
      currentElectionId: null,
      updatedAt: now,
    });
    expect((await seats.get(roomId))?.holderUserId).toBe(stewardId);
    // Upsert overwrites the same row (PK roomId).
    await seats.put({
      roomId,
      holderUserId: null,
      termStart: now,
      termEnd: end,
      bootstrap: false,
      currentElectionId: null,
      updatedAt: now,
    });
    const seat = await seats.get(roomId);
    expect(seat?.holderUserId).toBeNull();
    expect(seat?.bootstrap).toBe(false);
    expect((await seats.list()).some((s) => s.roomId === roomId)).toBe(true);
  });

  it('inserts an election, patches a settle, and lists by room', async () => {
    const electionId = randomUUID();
    const t = new Date().toISOString();
    await elections.insert({
      electionId,
      roomId,
      status: 'open',
      opensAt: t,
      closesAt: t,
      weightModel: 'one_civic_account_one_vote',
      winnerUserId: null,
      tally: null,
      mode: 'simulated',
      createdAt: t,
      settledAt: null,
    });
    const patched = await elections.patch(electionId, {
      status: 'settled',
      winnerUserId: candidateId,
      tally: [{ candidateUserId: candidateId, weight: 1 }],
      settledAt: t,
    });
    expect(patched?.status).toBe('settled');
    expect(patched?.winnerUserId).toBe(candidateId);
    expect(patched?.tally?.[0]?.weight).toBe(1);
    expect((await elections.listByRoom(roomId)).map((e) => e.electionId)).toContain(electionId);
  });

  it('enforces one ballot per voter on the composite PK (idempotent cast)', async () => {
    const electionId = randomUUID();
    const t = new Date().toISOString();
    await elections.insert({
      electionId,
      roomId,
      status: 'open',
      opensAt: t,
      closesAt: t,
      weightModel: 'one_civic_account_one_vote',
      winnerUserId: null,
      tally: null,
      mode: 'simulated',
      createdAt: t,
      settledAt: null,
    });
    const first = await votes.cast({
      electionId,
      voterUserId: voterId,
      candidateUserId: candidateId,
      weight: 1,
      castAt: t,
    });
    expect(first).not.toBeNull();
    // A second ballot from the same voter collides on the PK → null (idempotent).
    const second = await votes.cast({
      electionId,
      voterUserId: voterId,
      candidateUserId: stewardId,
      weight: 1,
      castAt: t,
    });
    expect(second).toBeNull();
    expect(await votes.listByElection(electionId)).toHaveLength(1);
  });

  it('inserts a model, rejects a duplicate digest, patches status, reads back the bundle', async () => {
    const t = new Date().toISOString();
    const modelId = randomUUID();
    const digest = 'a'.repeat(64);
    const m1 = await models.insert({
      modelId,
      roomId,
      artifactDigest: digest,
      bundle: bundleOf(),
      cardRef: null,
      proposedByUserId: stewardId,
      status: 'proposed',
      evaluationRef: null,
      createdAt: t,
    });
    expect(m1).not.toBeNull();
    // Same (room, digest) collides on the unique index → null.
    const dup = await models.insert({
      modelId: randomUUID(),
      roomId,
      artifactDigest: digest,
      bundle: bundleOf(),
      cardRef: null,
      proposedByUserId: stewardId,
      status: 'proposed',
      evaluationRef: null,
      createdAt: t,
    });
    expect(dup).toBeNull();
    const evalRef = randomUUID();
    const patched = await models.patchStatus(modelId, 'eligible', evalRef);
    expect(patched?.status).toBe('eligible');
    expect(patched?.evaluationRef).toBe(evalRef);
    expect((await models.listByRoom(roomId)).some((m) => m.modelId === modelId)).toBe(true);
    expect((await models.get(modelId))?.bundle.name).toBe('Civility');
  });

  it('binds a prompt to its model and resolves it by model id', async () => {
    const t = new Date().toISOString();
    const modelId = randomUUID();
    await models.insert({
      modelId,
      roomId,
      artifactDigest: 'c'.repeat(64),
      bundle: bundleOf(),
      cardRef: null,
      proposedByUserId: stewardId,
      status: 'eligible',
      evaluationRef: null,
      createdAt: t,
    });
    const promptId = randomUUID();
    await prompts.insert({
      promptId,
      roomId,
      modelId,
      promptDigest: 'd'.repeat(64),
      promptText: 'Be neutral.',
      proposedByUserId: stewardId,
      createdAt: t,
    });
    expect((await prompts.get(promptId))?.promptText).toBe('Be neutral.');
    expect((await prompts.getByModel(modelId))?.promptId).toBe(promptId);
  });

  it('stores a law-pack and an active binding (upsert + setActive)', async () => {
    const t = new Date().toISOString();
    const lawPackId = randomUUID();
    await lawPacks.insert({
      lawPackId,
      roomId,
      version: '1',
      lawPack: { ...defaultModerationLawPack(roomId), lawPackId },
      createdAt: t,
    });
    expect((await lawPacks.get(lawPackId))?.version).toBe('1');

    const modelId = randomUUID();
    await models.insert({
      modelId,
      roomId,
      artifactDigest: 'b'.repeat(64),
      bundle: bundleOf(),
      cardRef: null,
      proposedByUserId: stewardId,
      status: 'approved',
      evaluationRef: null,
      createdAt: t,
    });
    const promptId = randomUUID();
    await prompts.insert({
      promptId,
      roomId,
      modelId,
      promptDigest: 'e'.repeat(64),
      promptText: 'Be neutral.',
      proposedByUserId: stewardId,
      createdAt: t,
    });
    await bindings.put({
      roomId,
      modelId,
      promptId,
      lawPackId,
      approvedByElectionId: null,
      capabilityDescriptor: { granted: ['moderate.flag'] },
      active: true,
      floorFrozen: false,
      approvedAt: t,
    });
    expect((await bindings.get(roomId))?.capabilityDescriptor.granted).toEqual(['moderate.flag']);
    // The platform-floor freeze deactivates AND sets the durable floor-frozen flag.
    const frozen = await bindings.setActive(roomId, false, true);
    expect(frozen?.active).toBe(false);
    expect(frozen?.floorFrozen).toBe(true);
    expect((await bindings.get(roomId))?.floorFrozen).toBe(true);
  });

  it('appends agent actions newest-first and filters accepted treasury actions', async () => {
    const base = Date.now();
    for (const [i, type] of ['moderate.flag', 'moderate.remove'].entries()) {
      await agentActions.append({
        actionId: randomUUID(),
        roomId,
        bindingModelId: randomUUID(),
        promptHash: 'h'.repeat(16),
        actionType: type,
        subjectRef: randomUUID(),
        lawPackRuleRef: 'r1',
        statementOfReasons: `action ${i}`,
        reversible: type !== 'moderate.remove',
        createdAt: new Date(base + i * 1_000).toISOString(),
      });
    }
    const recent = await agentActions.listByRoom(roomId, 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.actionType).toBe('moderate.remove'); // newest first

    const accepted: Verdict = { accepted: true, evidence: { checks: [] } };
    const rejected: Verdict = {
      accepted: false,
      code: 'crypto_disabled',
      reason: 'Crypto features are disabled.',
    };
    await treasury.append({
      actionId: randomUUID(),
      roomId,
      category: 'grant',
      amount: 10,
      asset: null,
      targetAllocation: null,
      accepted: true,
      verdict: accepted,
      executedAt: new Date(base).toISOString(),
    });
    await treasury.append({
      actionId: randomUUID(),
      roomId,
      category: 'grant',
      amount: 5,
      asset: null,
      targetAllocation: null,
      accepted: false,
      verdict: rejected,
      executedAt: new Date(base + 1_000).toISOString(),
    });
    const acceptedRows = await treasury.acceptedByRoom(roomId);
    expect(acceptedRows).toHaveLength(1);
    expect(acceptedRows[0]?.amount).toBe(10);
  });

  it('deferred re-moderation queue: upsert-idempotent enqueue, FIFO list, attempt bump, remove', async () => {
    const ctx = {
      contentText: 'see http://a http://b http://c',
      contentKind: 'comment' as const,
      contentLength: 30,
      linkCount: 3,
      mentionCount: 0,
      hasMediaUpload: false,
      authorAccountAgeDays: 3,
      authorNewToRoom: true,
      priorRemovalsInRoom: 0,
    };
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    await pendingRemoderation.enqueue({
      roomId,
      subjectRef: 'contrib-A',
      context: ctx,
      enqueuedAt: older,
    });
    await pendingRemoderation.enqueue({
      roomId,
      subjectRef: 'contrib-B',
      context: ctx,
      enqueuedAt: newer,
    });
    // A re-defer of A UPSERTS (refreshes context, keeps attempts + enqueuedAt) — no duplicate row.
    await pendingRemoderation.enqueue({
      roomId,
      subjectRef: 'contrib-A',
      context: { ...ctx, linkCount: 9 },
      enqueuedAt: newer,
    });

    const listed = await pendingRemoderation.list(10);
    const mine = listed.filter((r) => r.roomId === roomId);
    expect(mine.map((r) => r.subjectRef)).toEqual(['contrib-A', 'contrib-B']); // oldest-first FIFO
    const a = mine.find((r) => r.subjectRef === 'contrib-A');
    expect(a?.attempts).toBe(0); // preserved across the re-defer
    expect(a?.context.linkCount).toBe(9); // context refreshed
    expect(a?.enqueuedAt).toBe(older); // original age preserved

    await pendingRemoderation.markAttempt(roomId, 'contrib-A', newer);
    const afterAttempt = (await pendingRemoderation.list(10)).find(
      (r) => r.roomId === roomId && r.subjectRef === 'contrib-A',
    );
    expect(afterAttempt?.attempts).toBe(1);
    expect(afterAttempt?.lastAttemptAt).not.toBeNull();

    await pendingRemoderation.remove(roomId, 'contrib-A');
    const remaining = (await pendingRemoderation.list(10)).filter((r) => r.roomId === roomId);
    expect(remaining.map((r) => r.subjectRef)).toEqual(['contrib-B']);
  });

  it('opens a ratification vote, enforces one ballot per voter, and patches the settle', async () => {
    const t = new Date().toISOString();
    const modelId = randomUUID();
    await models.insert({
      modelId,
      roomId,
      artifactDigest: 'f'.repeat(64),
      bundle: bundleOf(),
      cardRef: null,
      proposedByUserId: stewardId,
      status: 'eligible',
      evaluationRef: null,
      createdAt: t,
    });
    const voteId = randomUUID();
    await ratifications.insert({
      voteId,
      roomId,
      modelId,
      lawPackId: null,
      status: 'open',
      opensAt: t,
      closesAt: t,
      minQuorum: 1,
      eligibleCount: 0,
      openedByUserId: stewardId,
      tally: null,
      outcome: null,
      createdAt: t,
      settledAt: null,
    });
    expect((await ratifications.getOpenForRoom(roomId))?.voteId).toBe(voteId);

    // A second OPEN vote for the same room collides on the partial unique index
    // (one-open-per-room) and returns null — the atomic concurrency guard.
    const secondOpen = await ratifications.insert({
      voteId: randomUUID(),
      roomId,
      modelId,
      lawPackId: null,
      status: 'open',
      opensAt: t,
      closesAt: t,
      minQuorum: 1,
      eligibleCount: 0,
      openedByUserId: stewardId,
      tally: null,
      outcome: null,
      createdAt: t,
      settledAt: null,
    });
    expect(secondOpen).toBeNull();

    const first = await ratificationBallots.cast({
      voteId,
      voterUserId: voterId,
      choice: 'approve',
      castAt: t,
    });
    expect(first).not.toBeNull();
    // A second ballot from the same voter collides on the composite PK → null.
    const second = await ratificationBallots.cast({
      voteId,
      voterUserId: voterId,
      choice: 'reject',
      castAt: t,
    });
    expect(second).toBeNull();
    expect(await ratificationBallots.listByVote(voteId)).toHaveLength(1);

    const settled = await ratifications.patch(voteId, {
      status: 'settled',
      outcome: 'approved',
      settledAt: t,
    });
    expect(settled?.status).toBe('settled');
    expect(settled?.outcome).toBe('approved');
    // No longer open ⇒ off the open-room read.
    expect(await ratifications.getOpenForRoom(roomId)).toBeNull();
  });
});
