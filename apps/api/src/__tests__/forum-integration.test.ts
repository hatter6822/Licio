// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-G forum Drizzle adapters —
// the same interfaces the in-memory adapters satisfy, against the REAL
// migration chain (incl. 0008's enums, CHECKs, partial unique indexes, and
// the GIN path-containment index).  Run only when DATABASE_URL points at a
// pgvector-enabled Postgres (the chain installs the extension); skipped in CI.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import {
  DEFAULT_ROOM_NOTIFICATION_PREFERENCES,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrizzleContributionStore,
  DrizzleLensStore,
  DrizzleRoomStore,
  DrizzleUploadStore,
} from '../forum/drizzle-forum-stores.js';
import type { ContributionRecord, RoomRecord } from '../forum/stores.js';
import { DrizzleClaimStore, DrizzleStoryStore } from '../ingestion/drizzle-ingestion-stores.js';
import type { StoryRecord } from '../ingestion/stores.js';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('WS-G forum Drizzle adapters (live Postgres)', () => {
  let db: ReturnType<typeof createDbClient>;
  let authorId: string;
  let secondUserId: string;
  let threadId: string;
  let claimId: string;
  let defaultRoomId: string;
  let contributions: DrizzleContributionStore;
  let roomsStore: DrizzleRoomStore;
  let lenses: DrizzleLensStore;
  let uploads: DrizzleUploadStore;

  /** Stories/rooms this suite created (row-scoped cleanup). */
  const storyIds: string[] = [];
  const roomIds: string[] = [];
  const uploadIds: string[] = [];

  async function insertUser(label: string): Promise<string> {
    const { users } = await import('@licio/db');
    const inserted = await db
      .insert(users)
      .values({
        handle: `wsg_${label}_${randomUUID().slice(0, 8)}`,
        displayName: `WS-G ${label}`,
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        reputationSummaryPrivate: emptyReputationSummary(),
      })
      .returning();
    return (inserted[0] as { userId: string }).userId;
  }

  async function seedThread(
    stories: DrizzleStoryStore,
    roomId: string = defaultRoomId,
  ): Promise<string> {
    const storyId = randomUUID();
    const newThreadId = randomUUID();
    const created = await stories.createWithThread(
      {
        storyId,
        canonicalUrl: null,
        title: `WS-G adapter thread ${storyId.slice(0, 8)}`,
        titleHash: randomUUID().replaceAll('-', ''),
        submittedBy: authorId,
        sourceId: null,
        roomId,
        visibility: 'public',
        mediaUploadRef: null,
        canonicalPublicStoryId: null,
        language: 'en',
        topicIds: [randomUUID()],
        locationScope: null,
        sensitivityLabels: ['none'] as StoryRecord['sensitivityLabels'],
        lifecycleState: 'gathering_attention',
        submissionType: 'original_brief',
        submissionMetadata: { submission_type: 'original_brief', body: 'Seed body.' },
        excerpt: 'Seed body.',
        publisher: null,
        author: null,
        publishedAt: null,
        mediaType: null,
        extractionState: 'not_applicable',
        hiddenState: null,
      },
      newThreadId,
    );
    if (!created.ok) throw new Error('seedThread failed');
    storyIds.push(storyId);
    return newThreadId;
  }

  function contributionInput(
    over: Partial<
      Omit<ContributionRecord, 'createdAt' | 'updatedAt' | 'editHistoryRef' | 'disputeStatus'>
    > = {},
  ): Omit<ContributionRecord, 'createdAt' | 'updatedAt' | 'editHistoryRef' | 'disputeStatus'> {
    return {
      contributionId: randomUUID(),
      threadId,
      userId: authorId,
      type: 'question',
      body: 'What evidence supports the employment claim?',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `draft-${randomUUID()}`,
      path: [],
      moderationState: 'published',
      ...over,
    };
  }

  function roomInput(
    over: Partial<Omit<RoomRecord, 'createdAt' | 'updatedAt'>> = {},
  ): Omit<RoomRecord, 'createdAt' | 'updatedAt'> {
    const suffix = randomUUID().slice(0, 8);
    const record: Omit<RoomRecord, 'createdAt' | 'updatedAt'> = {
      roomId: randomUUID(),
      name: `WS-G Adapter Room ${suffix}`,
      slug: `wsg-adapter-room-${suffix}`,
      description: 'Adapter integration room.',
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      storageMode: 'server',
      createdBy: authorId,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
      frozen: false,
      migratedToRoomId: null,
      ...over,
    };
    return record;
  }

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    authorId = await insertUser('author');
    secondUserId = await insertUser('second');
    contributions = new DrizzleContributionStore(db);
    roomsStore = new DrizzleRoomStore(db);
    lenses = new DrizzleLensStore(db);
    uploads = new DrizzleUploadStore(db, null);
    const stories = new DrizzleStoryStore(db);
    // WS-Q — seedThread's stories need a home room (FK + NOT NULL).
    const defaultRoom = await roomsStore.insert(roomInput());
    if (!defaultRoom.ok) throw new Error('default room insert failed');
    defaultRoomId = defaultRoom.room.roomId;
    roomIds.push(defaultRoomId);
    threadId = await seedThread(stories);
    const claims = new DrizzleClaimStore(db);
    const claim = await claims.insert({
      claimId: randomUUID(),
      storyId: storyIds[0] ?? null,
      canonicalText: 'The reservoir level fell by 12% in May.',
      normalizedTextHash: randomUUID().replaceAll('-', ''),
      claimStatus: 'candidate',
      firstSeenStoryId: storyIds[0] ?? null,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'system',
      extractionConfidence: null,
      modelVersion: null,
    });
    claimId = claim.claimId;
  });

  afterAll(async () => {
    // ROW-SCOPED cleanup (the WS-D/E/F gated-test pattern): vitest projects
    // run in parallel against the SAME live database, so a blanket clear()
    // would race the other gated suites.  Dependents before referents;
    // threads cascade contributions/edit history/summaries, rooms cascade
    // stewards/subscriptions/lenses.
    const dbSchema = await import('@licio/db');
    const { inArray } = await import('drizzle-orm');
    if (storyIds.length > 0) {
      await db
        .delete(dbSchema.evidenceCards)
        .where(inArray(dbSchema.evidenceCards.storyId, storyIds));
      await db.delete(dbSchema.claims).where(inArray(dbSchema.claims.storyId, storyIds));
      await db.delete(dbSchema.threads).where(inArray(dbSchema.threads.storyId, storyIds));
      await db.delete(dbSchema.stories).where(inArray(dbSchema.stories.storyId, storyIds));
    }
    if (roomIds.length > 0) {
      await db.delete(dbSchema.rooms).where(inArray(dbSchema.rooms.roomId, roomIds));
    }
    if (uploadIds.length > 0) {
      await db.delete(dbSchema.uploads).where(inArray(dbSchema.uploads.uploadId, uploadIds));
    }
    const { users } = dbSchema;
    await db.delete(users).where(inArray(users.userId, [authorId, secondUserId]));
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  it('inserts a tree, dedups on (user, draft), and reads the subtree via path containment', async () => {
    const root = await contributions.insert(contributionInput());
    expect(root.ok && !root.duplicate).toBe(true);
    if (!root.ok) return;
    const rootId = root.contribution.contributionId;

    // Race-safe idempotent create: the same draft key returns the EXISTING row.
    const replay = await contributions.insert(
      contributionInput({ clientDraftId: root.contribution.clientDraftId }),
    );
    expect(replay.ok && replay.duplicate).toBe(true);
    if (replay.ok) expect(replay.contribution.contributionId).toBe(rootId);
    expect((await contributions.getByDraft(authorId, root.contribution.clientDraftId))?.body).toBe(
      root.contribution.body,
    );

    const child = await contributions.insert(
      contributionInput({
        type: 'answer',
        body: 'Table 3 of the labor report.',
        parentContributionId: rootId,
        path: [rootId],
      }),
    );
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const grandchild = await contributions.insert(
      contributionInput({
        type: 'question',
        body: 'Which edition of the report?',
        userId: secondUserId,
        parentContributionId: child.contribution.contributionId,
        path: [rootId, child.contribution.contributionId],
      }),
    );
    expect(grandchild.ok).toBe(true);

    // GIN containment subtree: descendants of root (excluding the root).
    const descendants = await contributions.listDescendants(rootId, { limit: 100 });
    expect(descendants.map((row) => row.contributionId).sort()).toEqual(
      [
        child.contribution.contributionId,
        grandchild.ok ? grandchild.contribution.contributionId : '',
      ].sort(),
    );
    // Subtree keyset walk: 1-row pages visit every descendant exactly once
    // (same-millisecond rows — the cursor must round-trip exactly).
    const subtreeWalk: string[] = [];
    let subtreeCursor: { createdAt: string; id: string } | null = null;
    for (;;) {
      const page = await contributions.listDescendants(rootId, {
        after: subtreeCursor,
        limit: 1,
      });
      const row = page[0];
      if (!row) break;
      subtreeWalk.push(row.contributionId);
      subtreeCursor = { createdAt: row.createdAt, id: row.contributionId };
    }
    expect(subtreeWalk).toEqual(descendants.map((row) => row.contributionId));

    // Filtered + keyset-paginated thread reads.
    const questionsOnly = await contributions.listByThread(threadId, {
      types: ['question'],
      states: ['published'],
      limit: 100,
    });
    expect(questionsOnly.every((row) => row.type === 'question')).toBe(true);
    // Keyset completeness: walking 1-row pages visits every row exactly once
    // (this is the microsecond-precision regression guard — rows are written
    // in the same millisecond, and the cursor must still round-trip exactly).
    const all = await contributions.listByThread(threadId, { limit: 100 });
    const walked: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (;;) {
      const page: ContributionRecord[] = await contributions.listByThread(threadId, {
        after: cursor,
        limit: 1,
      });
      const row = page[0];
      if (!row) break;
      walked.push(row.contributionId);
      cursor = { createdAt: row.createdAt, id: row.contributionId };
    }
    expect(walked).toEqual(all.map((row) => row.contributionId));
    expect(new Set(walked).size).toBe(walked.length);

    // Aggregates: per-type counts and published-only child counts.
    const counts = await contributions.countByType(threadId, ['published']);
    expect(counts.question ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.answer ?? 0).toBeGreaterThanOrEqual(1);
    const childCounts = await contributions.childCounts([
      rootId,
      child.contribution.contributionId,
    ]);
    expect(childCounts.get(rootId)).toBe(1);
    expect(childCounts.get(child.contribution.contributionId)).toBe(1);
    await contributions.setModerationState(
      grandchild.ok ? grandchild.contribution.contributionId : '',
      'hidden',
    );
    const afterHide = await contributions.childCounts([child.contribution.contributionId]);
    expect(afterHide.get(child.contribution.contributionId)).toBe(0);
  });

  it('co-creates the evidence card transactionally — both persist or neither', async () => {
    const { evidenceCards } = await import('@licio/db');
    const { eq } = await import('drizzle-orm');
    const good = contributionInput({
      type: 'evidence',
      body: 'Primary dataset for the claim.',
      citations: [{ url: 'https://example.org/data' }],
      targetClaimId: claimId,
    });
    const evidenceId = randomUUID();
    const created = await contributions.insert(good, {
      evidenceId,
      claimId,
      sourceId: null,
      submittedBy: authorId,
      evidenceType: 'dataset',
      relationshipType: 'supports',
      citationUrlOrRef: 'https://example.org/data',
      relevanceNote: 'Primary dataset for the claim.',
      independenceGroupId: null,
      storyId: storyIds[0] ?? null,
      contributionId: good.contributionId,
    });
    expect(created.ok).toBe(true);
    const card = await db
      .select()
      .from(evidenceCards)
      .where(eq(evidenceCards.evidenceId, evidenceId));
    expect(card[0]?.contributionId).toBe(good.contributionId);
    expect(card[0]?.evidenceType).toBe('dataset');
    expect(card[0]?.relationshipType).toBe('supports');

    // Failure path: an unknown claim id violates the FK INSIDE the
    // transaction — the contribution must not survive the rollback.
    const bad = contributionInput({ type: 'evidence', targetClaimId: claimId });
    await expect(
      contributions.insert(bad, {
        evidenceId: randomUUID(),
        claimId: randomUUID(), // no such claim
        sourceId: null,
        submittedBy: authorId,
        evidenceType: 'report',
        relationshipType: 'supports',
        citationUrlOrRef: 'https://example.org/x',
        relevanceNote: 'x',
        independenceGroupId: null,
        storyId: null,
        contributionId: bad.contributionId,
      }),
    ).rejects.toThrow();
    expect(await contributions.getById(bad.contributionId)).toBeNull();
  });

  it('snapshots edits append-only and tracks edit_history_ref', async () => {
    const created = await contributions.insert(contributionInput({ body: 'Original body.' }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.contribution.contributionId;
    const editId = randomUUID();
    const updated = await contributions.applyEdit(
      id,
      { body: 'Revised body.', citations: [{ url: 'https://example.org/new' }] },
      authorId,
      editId,
    );
    expect(updated?.body).toBe('Revised body.');
    expect(updated?.editHistoryRef).toBe(editId);
    const history = await contributions.listEditHistory(id);
    expect(history).toHaveLength(1);
    expect(history[0]?.previousBody).toBe('Original body.');
    expect(history[0]?.previousCitations).toEqual([]);
    expect(
      await contributions.applyEdit(randomUUID(), { body: 'x' }, authorId, randomUUID()),
    ).toBeNull();
  });

  it('tombstones the author on anonymize and frees the draft key (partial unique index)', async () => {
    const draftKey = `draft-${randomUUID()}`;
    const victim = await insertUser('victim');
    const created = await contributions.insert(
      contributionInput({ userId: victim, clientDraftId: draftKey }),
    );
    expect(created.ok).toBe(true);
    expect(await contributions.anonymizeUser(victim)).toBe(1);
    if (!created.ok) return;
    const tombstoned = await contributions.getById(created.contribution.contributionId);
    expect(tombstoned?.userId).toBeNull();
    expect(tombstoned?.body).toBe(created.contribution.body); // content persists (§22.4)
    expect(await contributions.listByUser(victim, null, 10)).toEqual([]);
    // The partial unique index only covers user_id IS NOT NULL rows: the same
    // draft key inserts a NEW row rather than colliding with the tombstone.
    const again = await contributions.insert(
      contributionInput({ userId: victim, clientDraftId: draftKey }),
    );
    expect(again.ok && !again.duplicate).toBe(true);
    const { users } = await import('@licio/db');
    const { eq } = await import('drizzle-orm');
    await db.delete(users).where(eq(users.userId, victim)); // FK is SET NULL
    if (again.ok) {
      expect((await contributions.getById(again.contribution.contributionId))?.userId).toBeNull();
    }
  });

  it('enforces the depth cap and path/parent consistency CHECKs at the storage layer', async () => {
    const parent = await contributions.insert(contributionInput());
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const elevenAncestors = Array.from({ length: 11 }, () => randomUUID());
    await expect(
      contributions.insert(
        contributionInput({
          parentContributionId: parent.contribution.contributionId,
          path: elevenAncestors,
        }),
      ),
    ).rejects.toThrow(); // contributions_depth_cap
    await expect(
      contributions.insert(contributionInput({ path: [randomUUID()] })),
    ).rejects.toThrow(); // contributions_path_parent_consistent (no parent, non-empty path)
  });

  it('surfaces lens-tagged contributions through the metadata key', async () => {
    const lensTagged = await contributions.insert(
      contributionInput({ metadata: { lens_id: randomUUID() } }),
    );
    expect(lensTagged.ok).toBe(true);
    const rows = await contributions.listLensTagged([threadId], 100);
    expect(
      rows.some(
        (row) =>
          row.contributionId === (lensTagged.ok ? lensTagged.contribution.contributionId : ''),
      ),
    ).toBe(true);
    expect(await contributions.listLensTagged([], 100)).toEqual([]);
  });

  it('maps room unique indexes to conflict outcomes and lists with filters', async () => {
    const base = roomInput();
    const created = await roomsStore.insert(base);
    expect(created.ok).toBe(true);
    roomIds.push(base.roomId);

    // Case-insensitive name uniqueness within the room type.
    const dupName = await roomsStore.insert(
      roomInput({ name: base.name.toUpperCase(), slug: `other-${randomUUID().slice(0, 8)}` }),
    );
    expect(dupName).toEqual({ ok: false, reason: 'duplicate_name' });
    // Slug uniqueness within the room type.
    const dupSlug = await roomsStore.insert(roomInput({ slug: base.slug }));
    expect(dupSlug).toEqual({ ok: false, reason: 'duplicate_slug' });
    // The same name under a DIFFERENT room type is allowed.
    const otherType = await roomsStore.insert(roomInput({ name: base.name, roomType: 'learning' }));
    expect(otherType.ok).toBe(true);
    if (otherType.ok) roomIds.push(otherType.room.roomId);

    const listed = await roomsStore.list({
      roomType: 'global_topic',
      visibilities: ['public'],
      query: base.name.slice(0, 20).toLowerCase(),
      limit: 10,
    });
    expect(listed.some((room) => room.roomId === base.roomId)).toBe(true);
    expect(await roomsStore.list({ query: '%nothing%matches%', limit: 10 })).toEqual([]);

    const updated = await roomsStore.update(base.roomId, {
      description: 'Updated.',
      charterSummary: 'Charter.',
    });
    expect(updated?.description).toBe('Updated.');
    expect(updated?.charterSummary).toBe('Charter.');

    // touchActivity is monotonic: a backwards write is a no-op.
    const t1 = '2026-06-01T00:00:00.000Z';
    const t2 = '2026-06-02T00:00:00.000Z';
    await roomsStore.touchActivity(base.roomId, t2);
    await roomsStore.touchActivity(base.roomId, t1);
    expect((await roomsStore.getById(base.roomId))?.latestActivityAt).toBe(t2);
  });

  it('round-trips stewards and subscriptions, and anonymize removes membership', async () => {
    const room = roomInput();
    expect((await roomsStore.insert(room)).ok).toBe(true);
    roomIds.push(room.roomId);

    const assignedAt = new Date().toISOString();
    await roomsStore.addSteward({
      roomId: room.roomId,
      userId: secondUserId,
      role: 'community_steward',
      assignedAt,
    });
    await roomsStore.addSteward({
      roomId: room.roomId,
      userId: secondUserId,
      role: 'community_steward',
      assignedAt,
    }); // idempotent (onConflictDoNothing)
    await roomsStore.addSteward({
      roomId: room.roomId,
      userId: secondUserId,
      role: 'evidence_steward',
      assignedAt,
    });
    expect(await roomsStore.listStewards(room.roomId)).toHaveLength(2);
    expect((await roomsStore.stewardRolesFor(room.roomId, secondUserId)).sort()).toEqual([
      'community_steward',
      'evidence_steward',
    ]);
    expect(await roomsStore.listStewardRoomsByUser(secondUserId)).toEqual([room.roomId]);
    expect(await roomsStore.removeSteward(room.roomId, secondUserId, 'evidence_steward')).toBe(
      true,
    );
    expect(await roomsStore.removeSteward(room.roomId, secondUserId, 'evidence_steward')).toBe(
      false,
    );

    // Subscription upsert: a pending request becomes active; the original
    // request id survives the conflict update (it is the approval handle).
    const requestId = randomUUID();
    const requestedAt = new Date().toISOString();
    const pending = await roomsStore.upsertSubscription({
      roomId: room.roomId,
      userId: authorId,
      status: 'pending',
      requestId,
      notificationPreferences: DEFAULT_ROOM_NOTIFICATION_PREFERENCES,
      requestedAt,
      joinedAt: null,
    });
    expect(pending.status).toBe('pending');
    expect(await roomsStore.countMembers(room.roomId)).toBe(0); // active only
    expect((await roomsStore.listJoinRequests(room.roomId)).map((s) => s.requestId)).toEqual([
      requestId,
    ]);
    expect((await roomsStore.getJoinRequest(requestId))?.userId).toBe(authorId);

    const activated = await roomsStore.upsertSubscription({
      roomId: room.roomId,
      userId: authorId,
      status: 'active',
      requestId: randomUUID(), // ignored on conflict — the original survives
      notificationPreferences: { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCES, new_evidence: true },
      requestedAt,
      joinedAt: new Date().toISOString(),
    });
    expect(activated.status).toBe('active');
    expect(activated.requestId).toBe(requestId);
    expect(activated.notificationPreferences.new_evidence).toBe(true);
    expect(await roomsStore.countMembers(room.roomId)).toBe(1);
    // Eligible voters = active subscribers ∪ stewards: authorId (active sub) +
    // secondUserId (community_steward, no active subscription) = 2 distinct, so a
    // steward-role voter is counted even though countMembers (active only) is 1.
    expect(await roomsStore.countEligibleVoters(room.roomId)).toBe(2);
    expect(await roomsStore.listJoinRequests(room.roomId)).toEqual([]);
    expect((await roomsStore.listSubscriptionsByUser(authorId)).map((s) => s.roomId)).toContain(
      room.roomId,
    );

    await roomsStore.anonymizeUser(authorId);
    await roomsStore.anonymizeUser(secondUserId);
    expect(await roomsStore.getSubscription(room.roomId, authorId)).toBeNull();
    expect(await roomsStore.listStewards(room.roomId)).toEqual([]);
    expect(await roomsStore.deleteSubscription(room.roomId, authorId)).toBe(false);
  });

  it('enforces one lens per (room, lens_type) and lists by room', async () => {
    const room = roomInput();
    expect((await roomsStore.insert(room)).ok).toBe(true);
    roomIds.push(room.roomId);
    const first = await lenses.insert({
      lensId: randomUUID(),
      roomId: room.roomId,
      name: 'Local residents',
      lensType: 'local_resident',
      description: 'People who live there.',
    });
    expect(first.ok).toBe(true);
    const duplicate = await lenses.insert({
      lensId: randomUUID(),
      roomId: room.roomId,
      name: 'Also locals',
      lensType: 'local_resident',
      description: null,
    });
    expect(duplicate).toEqual({ ok: false, reason: 'duplicate_lens_type' });
    const second = await lenses.insert({
      lensId: randomUUID(),
      roomId: room.roomId,
      name: 'Experts',
      lensType: 'expert',
      description: null,
    });
    expect(second.ok).toBe(true);
    expect((await lenses.listByRoom(room.roomId)).map((lens) => lens.lensType)).toEqual([
      'local_resident',
      'expert',
    ]);
    if (first.ok) expect((await lenses.getById(first.lens.lensId))?.name).toBe('Local residents');
  });

  it('round-trips upload records/bytes and tombstones the owner on anonymize', async () => {
    const uploadId = randomUUID();
    uploadIds.push(uploadId);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const record = await uploads.put(
      {
        uploadId,
        ownerUserId: secondUserId,
        contentType: 'image/jpeg',
        byteSize: bytes.length,
        altText: 'A harbor at dusk',
        storageRef: `uploads/${uploadId}`,
        metadataStripped: true,
        scanState: 'pending',
      },
      bytes,
    );
    expect(record.scanState).toBe('pending');
    expect(await uploads.getBytes(uploadId)).toEqual(bytes);
    await uploads.setScanState(uploadId, 'clear');
    expect((await uploads.getRecord(uploadId))?.scanState).toBe('clear');
    // The content-type allow-list CHECK rejects non-image/PDF types.
    await expect(
      uploads.put(
        {
          uploadId: randomUUID(),
          ownerUserId: secondUserId,
          contentType: 'text/html',
          byteSize: 1,
          altText: null,
          storageRef: `uploads/${randomUUID()}`,
          metadataStripped: true,
          scanState: 'pending',
        },
        new Uint8Array([1]),
      ),
    ).rejects.toThrow();
    // DSAR listing: the owner's records, oldest first (§19.3/GDPR Art. 15).
    expect((await uploads.listByOwner(secondUserId)).map((row) => row.uploadId)).toEqual([
      uploadId,
    ]);
    await uploads.anonymizeUser(secondUserId);
    expect((await uploads.getRecord(uploadId))?.ownerUserId).toBeNull();
    expect(await uploads.listByOwner(secondUserId)).toEqual([]);
    expect(await uploads.getRecord(randomUUID())).toBeNull();
  });

  it('the S3 byte path signs requests (SigV4) and round-trips through the fake bucket', async () => {
    const objects = new Map<string, Uint8Array>();
    const seenHeaders: Array<Record<string, string>> = [];
    const fakeS3: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      seenHeaders.push(headers);
      if (init?.method === 'PUT') {
        const body = init.body as Uint8Array;
        objects.set(url, new Uint8Array(body));
        return new Response(null, { status: 200 });
      }
      const stored = objects.get(url);
      if (!stored) return new Response(null, { status: 404 });
      const copy = new Uint8Array(stored);
      return new Response(copy.buffer as ArrayBuffer, { status: 200 });
    };
    const s3Store = new DrizzleUploadStore(
      db,
      {
        endpoint: 'https://s3.test.example',
        region: 'us-east-1',
        bucket: 'licio-uploads',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret',
        prefix: 'forum/',
      },
      fakeS3,
    );
    const uploadId = randomUUID();
    uploadIds.push(uploadId);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
    await s3Store.put(
      {
        uploadId,
        ownerUserId: authorId,
        contentType: 'image/jpeg',
        byteSize: bytes.length,
        altText: 'sigv4 round trip',
        storageRef: `uploads/${uploadId}`,
        metadataStripped: true,
        scanState: 'clear',
      },
      bytes,
    );
    // The PUT was SigV4-signed with the exact payload hash.
    const putHeaders = seenHeaders[0];
    expect(putHeaders?.['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(putHeaders?.['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect([...objects.keys()][0]).toContain(`/licio-uploads/forum/uploads/${uploadId}`);
    // The record lives in Postgres; the bytes come back from the bucket.
    expect((await s3Store.getRecord(uploadId))?.byteSize).toBe(bytes.length);
    expect(await s3Store.getBytes(uploadId)).toEqual(bytes);
    // A bucket miss degrades to null (and a GET is also signed).
    objects.clear();
    expect(await s3Store.getBytes(uploadId)).toBeNull();
    expect(seenHeaders.at(-1)?.['authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('listThreadsByRoom pages by the descending keyset exactly once', async () => {
    const room = roomInput();
    expect((await roomsStore.insert(room)).ok).toBe(true);
    roomIds.push(room.roomId);
    const stories = new DrizzleStoryStore(db);
    const threadIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      // Seed the story+thread directly IN this room (the WS-Q consistency
      // trigger forbids moving a thread to a room its story is not in).
      threadIds.push(await seedThread(stories, room.roomId));
    }
    const walked: string[] = [];
    let before: { createdAt: string; threadId: string } | null = null;
    for (;;) {
      const page = await stories.listThreadsByRoom(room.roomId, before, 2);
      if (page.length === 0) break;
      walked.push(...page.map((thread) => thread.threadId));
      const last = page[page.length - 1];
      if (!last) break;
      before = { createdAt: last.createdAt, threadId: last.threadId };
    }
    expect(new Set(walked).size).toBe(walked.length); // exactly once
    expect([...walked].sort()).toEqual([...threadIds].sort()); // complete
  });
});
