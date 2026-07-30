// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE CONTRACT, BOTH ADAPTERS — the moderation audit trail's pagination.
//
// The property is the only one a keyset cursor has to have, and it is the one that was
// broken: **walking the cursor to exhaustion visits every row exactly once.**
//
// It failed in production shape only.  The trail paged on a `(event_time, audit_id)`
// cursor, and the encoded timestamp was already lossy before any code touched it:
// Postgres stores `timestamptz` to the MICROSECOND, and the driver hands back a JS
// `Date`, which is MILLISECOND.  Measured against this database, five back-to-back
// `now()` inserts landed on .590531/.591106/.591394/.591673/.591967 — a cursor taken
// from the last of those encodes `.591`, and the next page's `event_time < '.591'`
// then skips the three rows between.  An action burst is precisely what clusters inside
// one millisecond, so the busiest stretches of an accountability record lost the most,
// and lost it silently.
//
// The in-memory adapter never reproduced it: its timestamps come from `Date.now()`, so
// they are millisecond values that round-trip exactly, and its ISO-string comparison is
// faithful.  Two adapters, one correct — with no suite standing over both, which is why
// this file exists rather than a unit test on either side.
//
// The gated leg carries a hard "it ran" assertion: a silently skipped leg proves nothing
// and reads exactly like a passing one.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleModerationAuditStore } from '../moderation/drizzle-moderation-stores.js';
import {
  InMemoryModerationAuditStore,
  type ModerationAuditRecord,
  type ModerationAuditStore,
} from '../moderation/stores.js';

const DB_URL = process.env['DATABASE_URL'];

/** Enough rows that a burst shares milliseconds, and enough pages that a per-page loss
 *  compounds rather than hiding in a single boundary. */
const ROWS = 40;
const PAGE = 7;

async function seed(store: ModerationAuditStore, subjectUserId: string): Promise<void> {
  for (let i = 0; i < ROWS; i++) {
    await store.append({
      actorUserId: null,
      actorRole: null,
      action: `contract_seed_${i}`,
      reasonCode: null,
      targetType: 'account',
      targetId: null,
      subjectUserId,
      priorState: null,
      nextState: null,
      reversible: false,
      linkedActionId: null,
      reportIds: [],
      coApproverUserId: null,
      notes: `row ${i}`,
    });
  }
}

/** Walk the cursor to exhaustion, exactly as the console route does. */
async function pageThrough(
  store: ModerationAuditStore,
  subjectUserId: string,
): Promise<ModerationAuditRecord[]> {
  const seen: ModerationAuditRecord[] = [];
  let afterOrdinal: number | undefined;
  // Bounded so a cursor that fails to ADVANCE fails the test instead of hanging it.
  for (let page = 0; page < ROWS + 5; page++) {
    const batch: ModerationAuditRecord[] = await store.list({
      subjectUserId,
      ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
      limit: PAGE,
    });
    if (batch.length === 0) return seen;
    seen.push(...batch);
    afterOrdinal = batch[batch.length - 1]?.ordinal;
  }
  throw new Error('cursor never exhausted — it is not advancing');
}

/** The contract, run once per adapter.
 *
 *  `newSubject` yields a subject id the adapter will ACCEPT — under Postgres that means a
 *  real `users` row, since the trail carries a foreign key to it.
 *
 *  `makeBurst` returns a store already holding `ROWS` rows whose VISIBLE (millisecond)
 *  timestamps do not separate them.  Without it this suite could pass vacuously: if every
 *  seeded row happened to land in its own millisecond, the old timestamp cursor would
 *  walk them correctly too and the completeness assertion would discriminate nothing.
 *
 *  Each adapter expresses the tie the way it can, and the difference is the bug:
 *  Postgres spreads the rows across MICROSECONDS inside a few milliseconds — the exact
 *  production shape, where the read value is rounded down and the cursor skips its own
 *  millisecond — while the in-memory clock has no sub-millisecond to lose, so it ties
 *  them outright.  Neither can be paged by a millisecond timestamp; both must be paged
 *  by the ordinal. */
function contract(
  name: string,
  make: () => ModerationAuditStore,
  makeBurst: (subject: string) => Promise<ModerationAuditStore>,
  newSubject: () => Promise<string>,
  ran: () => void,
): void {
  describe(name, () => {
    it('pages a burst the visible timestamps cannot separate', async () => {
      ran();
      const subject = await newSubject();
      const store = await makeBurst(subject);

      const walked = await pageThrough(store, subject);

      // The fixture IS the hazard, so assert it is: far fewer distinct millisecond
      // timestamps than rows.  If this ever holds trivially (one row per millisecond)
      // the completeness assertion below stops testing anything.
      expect(new Set(walked.map((r) => r.eventTime)).size).toBeLessThan(ROWS);
      expect(walked).toHaveLength(ROWS);
      expect(new Set(walked.map((r) => r.auditId)).size).toBe(ROWS);
      for (let i = 1; i < walked.length; i++) {
        expect(walked[i]?.ordinal).toBeLessThan(walked[i - 1]?.ordinal as number);
      }
    });

    it('pages every row exactly once, in strictly descending append order', async () => {
      ran();
      const store = make();
      const subject = await newSubject();
      await seed(store, subject);

      const walked = await pageThrough(store, subject);

      // COMPLETE: nothing dropped between pages.  This is the assertion the old cursor
      // failed — and only against Postgres, and only when rows shared a millisecond.
      expect(walked).toHaveLength(ROWS);
      // NO DUPLICATES: an inclusive or rounded-UP cursor repeats the boundary row.
      expect(new Set(walked.map((r) => r.auditId)).size).toBe(ROWS);
      // ORDERED: strictly descending, so the walk has a total order to be complete over.
      for (let i = 1; i < walked.length; i++) {
        expect(walked[i]?.ordinal).toBeLessThan(walked[i - 1]?.ordinal as number);
      }
      // The seeded actions come back newest-first, so the walk is the exact reverse of
      // the append order — pinning ORDER, not just membership.
      expect(walked.map((r) => r.action)).toEqual(
        Array.from({ length: ROWS }, (_, i) => `contract_seed_${ROWS - 1 - i}`),
      );
    });

    it('resolves a LEGACY audit-id cursor to the same position', async () => {
      ran();
      const store = make();
      const subject = await newSubject();
      await seed(store, subject);

      const first = await store.list({ subjectUserId: subject, limit: PAGE });
      const boundary = first[first.length - 1];
      expect(boundary).toBeDefined();

      // A console page opened before the ordinal deploy sends the row's id.  It must
      // land on the SAME next page as the ordinal cursor — the id is exact, so the row
      // resolves its own position.
      const byLegacy = await store.list({
        subjectUserId: subject,
        afterAuditId: (boundary as ModerationAuditRecord).auditId,
        limit: PAGE,
      });
      const byOrdinal = await store.list({
        subjectUserId: subject,
        afterOrdinal: (boundary as ModerationAuditRecord).ordinal,
        limit: PAGE,
      });
      expect(byLegacy.map((r) => r.auditId)).toEqual(byOrdinal.map((r) => r.auditId));
      expect(byLegacy).not.toHaveLength(0);
    });

    it('ENDS the walk on a cursor id that resolves to nothing', async () => {
      ran();
      const store = make();
      const subject = await newSubject();
      await seed(store, subject);

      // Restarting from the head instead would loop a paging reader forever while
      // looking like progress — so both adapters must return nothing.
      const orphaned = await store.list({
        subjectUserId: subject,
        afterAuditId: randomUUID(),
        limit: PAGE,
      });
      expect(orphaned).toEqual([]);
    });
  });
}

contract(
  'moderation audit cursor — in-memory',
  () => new InMemoryModerationAuditStore(),
  // A FROZEN clock gives every appended row the same `eventTime` — the in-memory shape
  // of the same hazard Postgres produces naturally under a burst.
  async (subject) => {
    const store = new InMemoryModerationAuditStore(() => 1_700_000_000_000);
    await seed(store, subject);
    return store;
  },
  async () => randomUUID(),
  () => {},
);

describe.skipIf(!DB_URL)('moderation audit cursor — live Postgres', () => {
  let db: ReturnType<typeof createDbClient>;
  let ran = false;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
  });

  afterAll(async () => {
    // The trail is APPEND-ONLY — a `BEFORE DELETE` trigger rejects row deletes — so the
    // seeded rows come out with the trigger disabled for this session.  TRUNCATE is not
    // an option here: it would take a developer's whole local trail, not just the seed.
    await db.execute(sql`SET session_replication_role = replica`);
    await db.execute(sql`DELETE FROM moderation_audit WHERE action LIKE 'contract_seed_%'`);
    await db.execute(sql`DELETE FROM users WHERE handle LIKE 'mac_subject_%'`);
    await db.execute(sql`SET session_replication_role = origin`);
    await db.$client.end();
  });

  contract(
    'adapter',
    () => new DrizzleModerationAuditStore(db),
    // MICROSECONDS, written explicitly so the hazard is deterministic rather than a
    // race against how fast this machine inserts.  137µs apart puts ~7 rows in each
    // millisecond with a distinct sub-millisecond position — which the driver rounds
    // away on read, leaving a cursor that names the millisecond and skips the rest of
    // it.  The ordinal is assigned in `generate_series` order, so it agrees with
    // `event_time` and the walk is the exact reverse of the insert.
    async (subject) => {
      await db.execute(sql`
        INSERT INTO moderation_audit (action, target_type, subject_user_id, notes, event_time)
        SELECT 'contract_seed_' || i, 'account', ${subject}::uuid, 'burst row ' || i,
               timestamptz '2026-01-01 00:00:00+00' + (i * 137) * interval '1 microsecond'
          FROM generate_series(0, ${ROWS - 1}) AS i`);
      return new DrizzleModerationAuditStore(db);
    },
    // A real `users` row: the trail carries `subject_user_id → users` and would reject
    // an invented id, so the fixture has to be as real as the constraint.
    async () => {
      const userId = randomUUID();
      await db.execute(sql`
        insert into users
          (user_id, handle, display_name, privacy_settings, personalization_settings)
        values (${userId}, ${`mac_subject_${userId.slice(0, 8)}`}, 'Audit cursor subject',
                '{}'::jsonb, '{}'::jsonb)`);
      return userId;
    },
    () => {
      ran = true;
    },
  );

  it('actually ran the gated leg (a skipped leg proves nothing)', () => {
    expect(ran).toBe(true);
  });
});
