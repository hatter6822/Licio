// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE PROPERTY: the audit trail's order is the order things actually happened in.
//
// Assignment was already a compare-and-set, so no case could be moved from a stale
// snapshot and every `assign` row named an edge a write performed.  What was still open
// was the GAP between the CAS committing and the audit row being appended: a reviewer
// delayed in that gap has their row land after a later reviewer's, and the most recent
// entry then names the wrong holder.  Following edges reconstructs it; reading by
// recency does not — and a trail that is only correct when read a particular way is a
// caveat, not a property.
//
// Both legs below inject a delay INTO that gap on purpose.  Without the unit the delay
// reorders the trail; with it there is no gap to delay in.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleItemSafetyStateStore } from '../events/drizzle-event-stores.js';
import { DrizzleModerationTransactor } from '../moderation/drizzle-moderation-stores.js';
import {
  createInMemoryModerationServices,
  type ModerationServices,
} from '../moderation/services.js';
import type { ModerationTx } from '../moderation/transactor.js';

const DB_URL = process.env['DATABASE_URL'];

async function makeUser(db: ReturnType<typeof createDbClient>, label: string): Promise<string> {
  const userId = randomUUID();
  await db.execute(sql`
    insert into users (user_id, handle, display_name, privacy_settings, personalization_settings)
    values (${userId}, ${`tx_${label}_${userId.slice(0, 8)}`}, ${label}, '{}'::jsonb, '{}'::jsonb)`);
  return userId;
}

/** A promise plus the handle that settles it — the gap opener. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('moderation transactor — in-memory', () => {
  let services: ModerationServices;
  let caseId: string;

  beforeEach(async () => {
    services = createInMemoryModerationServices();
    const created = await services.cases.insert({
      caseId: randomUUID(),
      targetType: 'content',
      targetId: randomUUID(),
      contentKind: 'contribution',
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    caseId = created.caseId;
  });

  /** One reviewer taking the case, with a controllable pause inside the unit. */
  async function claim(reviewer: string, pause?: Promise<void>): Promise<void> {
    await services.transactor.run(async (tx) => {
      const claimed = await tx.cases.claimIfUnassigned(caseId, reviewer);
      if (!claimed) throw new Error('lost the claim');
      if (pause) await pause;
      await tx.audit({
        actorUserId: null,
        actorRole: null,
        action: 'assign',
        caseId,
        targetType: 'content',
        priorState: 'unassigned',
        nextState: reviewer,
      });
    });
  }

  async function reassign(from: string, to: string): Promise<void> {
    await services.transactor.run(async (tx) => {
      const moved = await tx.cases.reassignIfHeldBy(caseId, from, to);
      if (!moved) throw new Error('lost the reassign');
      await tx.audit({
        actorUserId: null,
        actorRole: null,
        action: 'assign',
        caseId,
        targetType: 'content',
        priorState: from,
        nextState: to,
      });
    });
  }

  const trail = async (): Promise<string[]> =>
    (await services.audit.list({ caseId, limit: 50 }))
      .reverse()
      .map((r) => `${r.priorState}->${r.nextState}`);

  it('orders the trail by what happened, even when a unit is DELAYED mid-flight', async () => {
    const held = gate();
    // B claims but stalls between its CAS and its audit row — the gap the defect lived
    // in.  C's whole reassignment is issued while B is stalled.
    const first = claim('reviewer-b', held.wait);
    let secondDone = false;
    const second = (async () => {
      await reassign('reviewer-b', 'reviewer-c');
      secondDone = true;
    })();

    // THE STALL HAS TO BE REAL.  Opening the gate in the same tick that issues C leaves
    // both units racing on microtasks, which they win or lose for reasons that have
    // nothing to do with the seam — the assertion below then holds with no unit at all,
    // and the test proves nothing.  So B is held across many event-loop turns, which is
    // every opportunity C needs to run to completion.
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    // It did not run, and THIS is the property: C's CAS cannot land while B's unit is
    // open, so there is no gap for B's audit row to arrive late in.  Unserialised, C
    // would be finished by now with its row already in the trail ahead of B's.
    expect(secondDone).toBe(false);
    expect(await trail()).toEqual([]);

    held.open();
    await Promise.all([first, second]);

    // The most recent entry names the CURRENT holder, which is the whole claim.
    expect(await trail()).toEqual(['unassigned->reviewer-b', 'reviewer-b->reviewer-c']);
    expect((await services.cases.getById(caseId))?.assignedTo).toBe('reviewer-c');
  });

  it('ROLLS BACK the state change when the audit append fails', async () => {
    // The inversion this seam buys: not "enforcement proceeds, accountability degrades",
    // but "no state change without its record".
    services.auditChain = {
      ...services.auditChain,
      store: {
        ...services.auditChain.store,
        chainHead: async () => null,
        appendChained: async () => {
          throw new Error('audit store unavailable');
        },
      },
    };

    await expect(claim('reviewer-b')).rejects.toThrow('audit store unavailable');
    // The CAS is GONE.  Before, it would have committed and left an unaudited claim.
    expect((await services.cases.getById(caseId))?.assignedTo).toBeNull();
    expect(await trail()).toEqual([]);
  });

  it('JOINS a nested unit rather than deadlocking on its own queue', async () => {
    // A nested `run` must join the ambient unit.  Serialised without the join, the inner
    // call would wait for a queue slot its own caller is holding — a hang, not a slowdown,
    // and one that only shows up when some composite path grows a second unit inside it.
    const seen = await services.transactor.run(async (outer) => {
      const before = await outer.cases.claimIfUnassigned(caseId, 'reviewer-b');
      const inner = await services.transactor.run(async (tx) => tx.cases.getById(caseId));
      return { before: before?.assignedTo ?? null, inner: inner?.assignedTo ?? null };
    });
    // The inner unit sees the OUTER unit's uncommitted write, because it is the same
    // unit — exactly what a savepoint-free nested transaction gives in Postgres.
    expect(seen).toEqual({ before: 'reviewer-b', inner: 'reviewer-b' });
  });
});

describe.skipIf(!DB_URL)('moderation transactor — live Postgres', () => {
  let db: ReturnType<typeof createDbClient>;
  let transactor: DrizzleModerationTransactor;
  let caseId: string;
  let ran = false;
  let alice: string;
  let bob: string;
  const cleanup: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    // `moderation_cases.assigned_to` is a real FK, so the reviewers have to be real.
    alice = await makeUser(db, 'alice');
    bob = await makeUser(db, 'bob');
    transactor = new DrizzleModerationTransactor(
      db,
      () => ({
        store: { chainHead: async () => null } as never,
        key: 'transactor-test-key',
        refOf: (id) => id,
      }),
      // This suite drives the moderation stores directly; the enforcement binding is
      // exercised by `moderation-services.test.ts`, so a no-op keeps the unit honest
      // about what it is testing.
      () => ({
        applyContentState: async () => {},
        applyAccountState: async () => {},
      }),
      // The §21.4 directory binding: unused by these units, present because the
      // shape is part of the unit rather than optional.
      () => async () => false,
    );
  });

  afterAll(async () => {
    // ONE TRANSACTION for the whole cleanup.  `session_replication_role` is a SESSION
    // setting, and the pool hands each statement whichever connection is free — so the
    // `SET` and the `DELETE` it is meant to cover can land on different connections and
    // the append-only trigger fires anyway.  `SET LOCAL` inside a transaction is scoped
    // to that transaction, which is exactly one connection.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM moderation_audit WHERE action = 'transactor_probe'`);
      for (const id of cleanup) {
        await tx.execute(sql`DELETE FROM moderation_cases WHERE case_id = ${id}::uuid`);
      }
      for (const id of [alice, bob]) {
        await tx.execute(sql`DELETE FROM users WHERE user_id = ${id}::uuid`);
      }
    });
    await db.$client.end();
  });

  beforeEach(async () => {
    const rows = (await db.execute(sql`
      INSERT INTO moderation_cases (target_type, target_id, content_kind, severity, routed_to, sla_due_at)
      VALUES ('content', gen_random_uuid(), 'contribution', 'moderate', 'standard', now() + interval '1 hour')
      RETURNING case_id::text AS case_id`)) as unknown as Array<{ case_id: string }>;
    caseId = rows[0]?.case_id as string;
    expect(caseId).toBeDefined();
    cleanup.push(caseId);
  });

  const audit = async (tx: ModerationTx, prior: string, next: string): Promise<void> => {
    await tx.audit({
      actorUserId: null,
      actorRole: null,
      action: 'transactor_probe',
      caseId,
      targetType: 'content',
      priorState: prior,
      nextState: next,
    });
  };

  it('a dependent unit cannot overtake the one it depends on', async () => {
    ran = true;
    const claimed = gate();
    const held = gate();

    // Unit A: claim, announce that its CAS has run, then stall INSIDE the unit.
    const a = transactor.run(async (tx) => {
      const row = await tx.cases.claimIfUnassigned(caseId, alice);
      expect(row).not.toBeNull();
      claimed.open();
      await held.wait;
      await audit(tx, 'unassigned', alice);
    });

    // Unit B takes the case OFF alice, so it cannot even begin until alice is the
    // visible holder — and alice becomes visible only when A COMMITS.  That is the
    // whole guarantee, and it is stronger than blocking: B is not waiting on a lock,
    // its precondition simply does not exist yet.  Before the seam, A's CAS committed
    // on its own and B could observe it while A's audit row was still unwritten.
    await claimed.wait;
    let attempts = 0;
    const b = (async () => {
      for (;;) {
        attempts += 1;
        const moved = await transactor.run(async (tx) => {
          const row = await tx.cases.reassignIfHeldBy(caseId, alice, bob);
          if (!row) return false;
          await audit(tx, alice, bob);
          return true;
        });
        if (moved) return;
        if (attempts > 200) throw new Error('B never observed the claim');
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    // Give B every chance to overtake before A is allowed to finish.
    await new Promise((r) => setTimeout(r, 60));
    held.open();
    await Promise.all([a, b]);

    // B had to try and fail while A was in flight — proof the fixture actually put the
    // two units in contention rather than running them one after the other.
    expect(attempts).toBeGreaterThan(1);

    const rows = (await db.execute(sql`
      SELECT prior_state, next_state FROM moderation_audit
       WHERE case_id = ${caseId}::uuid ORDER BY ordinal`)) as unknown as Array<{
      prior_state: string;
      next_state: string;
    }>;
    // A's row FIRST despite A being the delayed one.
    expect(rows.map((r) => `${r.prior_state}->${r.next_state}`)).toEqual([
      `unassigned->${alice}`,
      `${alice}->${bob}`,
    ]);
  });

  it('ROLLS BACK the CAS when the audit insert fails', async () => {
    ran = true;
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION transactor_probe_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit insert refused'; END;
      $$ LANGUAGE plpgsql`);
    // SCOPED TO THIS TEST'S CASE.  A trigger is a database-wide object visible to every
    // connection, and the gated suites share one live database while vitest runs their
    // FILES in parallel — so an unconditional BEFORE INSERT on `moderation_audit` fails
    // every sibling's audit write for as long as it is attached, as a moderation defect
    // in a suite that touched nothing.  The `WHEN` clause makes it fire only for the row
    // this test is about (`case_id` is NULL or another uuid everywhere else, and neither
    // matches), which is all the test ever needed.  Inlined rather than bound: a
    // `CREATE TRIGGER` is DDL and takes no parameters, and the value is a `randomUUID`.
    await db.execute(sql`
      CREATE TRIGGER transactor_probe_fail BEFORE INSERT ON moderation_audit
      FOR EACH ROW WHEN (NEW.case_id = ${sql.raw(`'${caseId}'`)}::uuid)
      EXECUTE FUNCTION transactor_probe_fail()`);
    try {
      await expect(
        transactor.run(async (tx) => {
          await tx.cases.claimIfUnassigned(caseId, alice);
          await audit(tx, 'unassigned', alice);
        }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS transactor_probe_fail ON moderation_audit`);
      await db.execute(sql`DROP FUNCTION transactor_probe_fail()`);
    }

    // Unassigned still.  The claim did not survive its missing record.
    const rows = (await db.execute(sql`
      SELECT assigned_to FROM moderation_cases WHERE case_id = ${caseId}::uuid`)) as unknown as Array<{
      assigned_to: string | null;
    }>;
    expect(rows[0]?.assigned_to).toBeNull();
  });

  it('ROLLS BACK the ENFORCEMENT itself, across bounded contexts', async () => {
    ran = true;
    const itemId = randomUUID();
    // A transactor whose enforcement binding is real: the WS-E item-safety write, bound
    // to the unit's handle exactly as the composition root binds it in production.
    const enforcing = new DrizzleModerationTransactor(
      db,
      () => ({ store: { chainHead: async () => null } as never, key: 'k', refOf: (id) => id }),
      (exec) => ({
        applyContentState: async () => {
          await new DrizzleItemSafetyStateStore(exec).set({
            itemId,
            safetyState: 'removed',
            frozenScore: null,
            frozenActiveAttention: null,
            frozenParticipation: null,
            caseId: null,
            updatedBy: alice,
            updatedAt: new Date().toISOString(),
          });
        },
        applyAccountState: async () => {},
      }),
      // The §21.4 directory binding: unused by these units, present because the
      // shape is part of the unit rather than optional.
      () => async () => false,
    );

    await expect(
      enforcing.run(async (tx) => {
        await tx.content.applyContentState(itemId, 'contribution', 'removed', null, alice);
        // Whatever fails after the effect — an audit refusal, a constraint, a crash on the
        // record side — must take the enforcement with it.
        throw new Error('record failed after the effect');
      }),
    ).rejects.toThrow('record failed after the effect');

    // NO suppression survives.  Before this binding existed the safety row committed on
    // its own, and content stayed excluded from ranking with nothing recording why —
    // the state that made a phantom "revert handle" look necessary.
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM item_safety_states WHERE item_id = ${itemId}::uuid`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
  });

  it('an enforcement RETRY inside a unit needs a savepoint, and gets one', async () => {
    ran = true;
    // THE MECHANISM THE REINSTATE PATH RUNS ON.  Un-hiding a story re-enters the tier
    // unique's partial index, so a re-submission that took the URL slot meanwhile makes
    // the write raise 23505 — which the composition root CATCHES and then READS from, to
    // find out whether the occupant is still there or the race resolved itself.
    //
    // Under autocommit that read is fine.  Inside a unit it is not: Postgres puts the
    // WHOLE transaction into an aborted state on any error, so the next statement fails
    // with 25P02 and the retry, the metric, the log line and the specific error are all
    // replaced by a bare "current transaction is aborted".  `attempt` therefore wraps
    // each such write in a nested `transaction()`, which drizzle emits as a SAVEPOINT.
    //
    // Both halves are checked: only the contrast shows the savepoint is load-bearing.
    // A temp table with `ON COMMIT DROP` supplies the 23505 without touching real data.
    let abortedCode: string | undefined;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`CREATE TEMP TABLE sp_probe_a (k int PRIMARY KEY) ON COMMIT DROP`);
        await tx.execute(sql`INSERT INTO sp_probe_a VALUES (1)`);
        try {
          await tx.execute(sql`INSERT INTO sp_probe_a VALUES (1)`);
        } catch {
          /* the 23505 the caller means to handle */
        }
        // The caller's next statement — its read, in the real path.
        await tx.execute(sql`SELECT count(*) FROM sp_probe_a`).catch((error: unknown) => {
          // Drizzle wraps the driver error, so the SQLSTATE is on the cause.  25P02 is
          // `current transaction is aborted, commands ignored until end of block`.
          abortedCode = (error as { cause?: { code?: string } }).cause?.code;
          throw error;
        });
      }),
    ).rejects.toThrow();
    expect(abortedCode).toBe('25P02');

    // WITH the savepoint the transaction survives, so the caller's read runs and its own
    // handling — retry, metric, log, a specific error — happens as written.
    const survived = await db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE sp_probe_b (k int PRIMARY KEY) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO sp_probe_b VALUES (1)`);
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`INSERT INTO sp_probe_b VALUES (1)`);
        });
      } catch {
        /* the 23505, rolled back to the savepoint */
      }
      const rows = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM sp_probe_b`,
      )) as unknown as Array<{ n: number }>;
      return rows[0]?.n;
    });
    expect(survived).toBe(1);
  });

  it('actually ran the gated legs (a skipped leg proves nothing)', () => {
    expect(ran).toBe(true);
  });
});
