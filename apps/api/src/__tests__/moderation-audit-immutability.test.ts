// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The audit trail is append-only, and this is the suite that holds the DATABASE to it
// rather than the code.  Every application write path goes through `append()`, so an
// application-level test proves only that the code does not try — it says nothing about
// what the table would accept from a psql session, a migration, or a future writer.
//
// The trigger enforcing this used to enumerate the columns an UPDATE may not change,
// which is an allowlist by OMISSION: `ordinal` (migration 0115) landed outside the list
// and was freely rewritable — the pagination key, and the sequence a tamper-evident
// chain has to be defined over.  Migration 0116 inverted it, so the assertions below are
// about columns that DO NOT EXIST YET as much as the ones that do.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env['DATABASE_URL'];

/** Run a statement that MUST be refused, and return the whole error chain's messages.
 *
 *  Drizzle wraps a driver error in `Failed query: …` and hangs the real one — the
 *  trigger's `append-only` RAISE — on `cause`, so a naive `rejects.toThrow(/append-only/)`
 *  fails against a correctly-refused statement.  Walking the chain asserts the REASON,
 *  not merely that something went wrong; and a statement that SUCCEEDS throws here, so
 *  this can never pass by not-refusing. */
async function refusalReason(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return messages.join(' | ');
  }
  throw new Error('the statement was ACCEPTED — the trail is not append-only');
}

describe.skipIf(!DB_URL)('moderation_audit is append-only in the DATABASE', () => {
  let db: ReturnType<typeof createDbClient>;
  let auditId: string;
  let userId: string;
  let ran = false;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    userId = randomUUID();
    await db.execute(sql`
      insert into users (user_id, handle, display_name, privacy_settings, personalization_settings)
      values (${userId}, ${`imm_${userId.slice(0, 8)}`}, 'Immutability subject',
              '{}'::jsonb, '{}'::jsonb)`);
    const rows = (await db.execute(sql`
      insert into moderation_audit (action, target_type, subject_user_id, notes)
      values ('immutability_probe', 'account', ${userId}::uuid, 'original')
      returning audit_id::text as audit_id`)) as unknown as Array<{ audit_id: string }>;
    auditId = rows[0]?.audit_id as string;
  });

  afterAll(async () => {
    await db.execute(sql`SET session_replication_role = replica`);
    await db.execute(sql`DELETE FROM moderation_audit WHERE action = 'immutability_probe'`);
    await db.execute(sql`DELETE FROM users WHERE user_id = ${userId}::uuid`);
    await db.execute(sql`SET session_replication_role = origin`);
    await db.$client.end();
  });

  it('REFUSES to renumber the ordinal', async () => {
    ran = true;
    // The gap migration 0116 closed.  An ordinal that can be rewritten is a pagination
    // key that can be reordered and a chain sequence that can be renumbered — silently,
    // by an UPDATE the old trigger had no clause about.
    expect(
      await refusalReason(() =>
        db.execute(
          sql`UPDATE moderation_audit SET ordinal = ordinal + 1000 WHERE audit_id = ${auditId}::uuid`,
        ),
      ),
    ).toMatch(/append-only/);
  });

  it('REFUSES to rewrite the case binding', async () => {
    ran = true;
    // `case_id` (0117) arrived AFTER the trigger was inverted, so it is covered without
    // anyone having added a clause for it — which is the property being tested.
    expect(
      await refusalReason(() =>
        db.execute(
          sql`UPDATE moderation_audit SET case_id = gen_random_uuid() WHERE audit_id = ${auditId}::uuid`,
        ),
      ),
    ).toMatch(/append-only/);
  });

  it('REFUSES to rewrite the substance', async () => {
    ran = true;
    expect(
      await refusalReason(() =>
        db.execute(
          sql`UPDATE moderation_audit SET notes = 'rewritten' WHERE audit_id = ${auditId}::uuid`,
        ),
      ),
    ).toMatch(/append-only/);
    expect(
      await refusalReason(() =>
        db.execute(sql`DELETE FROM moderation_audit WHERE audit_id = ${auditId}::uuid`),
      ),
    ).toMatch(/append-only/);
  });

  it('REFUSES to repoint a user reference at a DIFFERENT user', async () => {
    ran = true;
    // The erasure exemption is directional: towards NULL only.  Swapping one subject for
    // another would rewrite who an action was taken against while looking like a scrub.
    expect(
      await refusalReason(() =>
        db.execute(
          sql`UPDATE moderation_audit SET subject_user_id = gen_random_uuid() WHERE audit_id = ${auditId}::uuid`,
        ),
      ),
    ).toMatch(/append-only/);
  });

  it('PERMITS the right-to-erasure NULLing, which the purge depends on', async () => {
    ran = true;
    // The one exemption (SPEC §19.2 / the WS-D account purge).  If the inversion had
    // been written slightly too strictly this would fail and a hard purge would be
    // impossible — which is why it is asserted next to the refusals.
    await db.execute(
      sql`UPDATE moderation_audit SET subject_user_id = NULL WHERE audit_id = ${auditId}::uuid`,
    );
    const rows = (await db.execute(
      sql`SELECT subject_user_id FROM moderation_audit WHERE audit_id = ${auditId}::uuid`,
    )) as unknown as Array<{ subject_user_id: string | null }>;
    expect(rows[0]?.subject_user_id).toBeNull();
  });

  it('actually ran the gated legs (a skipped leg proves nothing)', () => {
    expect(ran).toBe(true);
  });
});
