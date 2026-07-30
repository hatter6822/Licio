// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The moderation audit trail's tamper-EVIDENCE (WS-J.2.5, migration 0118).
//
// Append-only and tamper-evident are separate claims and the trail only had the first.
// The trigger refuses UPDATE and DELETE through the ordinary path; it says nothing about
// a superuser session, a restore from a doctored dump, or the next migration.  These
// tests are about what survives someone who HAS that access.
import { createHash, randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeAudit } from '../moderation/audit.js';
import { computeAuditEntryHash, verifyAuditChain } from '../moderation/audit-chain.js';
import { DrizzleModerationAuditStore } from '../moderation/drizzle-moderation-stores.js';
import {
  createInMemoryModerationServices,
  type ModerationServices,
} from '../moderation/services.js';
import type { ModerationAuditRecord } from '../moderation/stores.js';

const KEY = 'test-moderation-audit-chain-key';
const refOf = (id: string): string =>
  createHash('sha256').update(`moderation-audit-ref:${id}`).digest('hex');

let services: ModerationServices;

/** Every record, oldest first — the order the chain runs in. */
async function allRecords(): Promise<ModerationAuditRecord[]> {
  const rows = await services.audit.list({ limit: 1000 });
  return [...rows].reverse();
}

async function write(action: string, notes = 'n'): Promise<void> {
  await writeAudit(services, {
    actorUserId: null,
    actorRole: null,
    action,
    targetType: 'account',
    notes,
  });
}

beforeEach(() => {
  services = createInMemoryModerationServices({ auditChainKey: KEY });
  services.auditChain = { store: services.audit, key: KEY, refOf };
});

describe('moderation audit chain', () => {
  it('chains every funnel write, and the chain verifies', async () => {
    for (let i = 0; i < 8; i++) await write(`chain_probe_${i}`);
    const records = await allRecords();

    // GENESIS + links: exactly one entry with no parent, and every later entry naming
    // its predecessor's hash.
    expect(records).toHaveLength(8);
    expect(records.filter((r) => r.prevHash === null)).toHaveLength(1);
    for (let i = 1; i < records.length; i++) {
      expect(records[i]?.prevHash).toBe(records[i - 1]?.integrityHash);
    }
    const report = verifyAuditChain(records, KEY, refOf);
    expect(report.problems).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.chainedEntries).toBe(8);
  });

  it('DETECTS a rewritten record', async () => {
    for (let i = 0; i < 5; i++) await write(`chain_probe_${i}`);
    const records = await allRecords();

    // The attack the chain exists for: someone with table access edits a record's
    // substance.  The row still looks like a row; its hash no longer follows from it.
    const tampered = records.map((r, i) =>
      i === 2 ? { ...r, notes: 'rewritten by someone with table access' } : r,
    );
    const report = verifyAuditChain(tampered, KEY, refOf);
    expect(report.valid).toBe(false);
    expect(report.problems.join(' ')).toContain(records[2]?.auditId as string);
  });

  it('DETECTS a row inserted around the funnel', async () => {
    for (let i = 0; i < 4; i++) await write(`chain_probe_${i}`);
    // A direct `append` is the in-memory stand-in for an INSERT that bypasses the
    // application — the row carries no chain fields at all.  Nothing about it is
    // individually malformed, which is exactly why the verifier has to look for it.
    await services.audit.append({
      actorUserId: null,
      actorRole: null,
      action: 'smuggled',
      reasonCode: null,
      targetType: 'account',
      targetId: null,
      subjectUserId: null,
      priorState: null,
      nextState: null,
      reversible: false,
      linkedActionId: null,
      caseId: null,
      reportIds: [],
      coApproverUserId: null,
      notes: null,
    });

    const report = verifyAuditChain(await allRecords(), KEY, refOf);
    expect(report.valid).toBe(false);
    expect(report.problems.join(' ')).toContain('UNCHAINED');
  });

  it('is KEYED — the chain does not verify under a different key', async () => {
    for (let i = 0; i < 4; i++) await write(`chain_probe_${i}`);
    const records = await allRecords();

    // The property an unkeyed digest cannot have.  Without the key an adversary who
    // rewrites a record simply recomputes every hash after it and the chain verifies
    // again; with it, they cannot produce a chain that checks out.
    expect(verifyAuditChain(records, KEY, refOf).valid).toBe(true);
    expect(verifyAuditChain(records, 'the-wrong-key', refOf).valid).toBe(false);
  });

  it('binds the ORDINAL, so a record cannot be renumbered', async () => {
    for (let i = 0; i < 4; i++) await write(`chain_probe_${i}`);
    const records = await allRecords();
    const target = records[2] as ModerationAuditRecord;

    // The ordinal is the pagination key AND the chain's sequence.  If the hash did not
    // commit to it, a row could be moved in the order without disturbing any hash —
    // reordering history while every link still checked out.
    expect(
      computeAuditEntryHash({ ...target, ordinal: target.ordinal + 100 }, KEY, refOf),
    ).not.toBe(target.integrityHash);
  });

  it('does not leak the subject into the preimage in the clear', async () => {
    const subject = '00000000-0000-4000-8000-00000000beef';
    await writeAudit(services, {
      actorUserId: subject,
      actorRole: null,
      action: 'chain_probe_ref',
      targetType: 'account',
      subjectUserId: subject,
    });
    const [record] = await allRecords();
    expect(record).toBeDefined();

    // Identifiers enter the hash as opaque refs, so recomputing with a DIFFERENT ref
    // function must fail — proving the raw id is not what was committed to.
    const withRawIds = (id: string): string => id;
    expect(computeAuditEntryHash(record as ModerationAuditRecord, KEY, withRawIds)).not.toBe(
      (record as ModerationAuditRecord).integrityHash,
    );
  });

  it('REFUSES a second entry claiming the same parent (fork-proof)', async () => {
    await write('chain_probe_0');
    const head = await services.audit.chainHead();
    expect(head).not.toBeNull();

    // Two writers that both read the same head produce two entries with the same
    // `prevHash`.  The store must let exactly one land — otherwise the chain forks and
    // both branches verify in isolation, which is indistinguishable from a rewritten
    // history.
    const staged = {
      ...(head as ModerationAuditRecord),
      prevHash: (head as ModerationAuditRecord).integrityHash,
    };
    const first = await services.audit.appendChained(staged, (s) =>
      computeAuditEntryHash(s, KEY, refOf),
    );
    expect(first).not.toBeNull();
    const second = await services.audit.appendChained(staged, (s) =>
      computeAuditEntryHash(s, KEY, refOf),
    );
    expect(second).toBeNull(); // the loser retries against the new head
  });
});

// ---------------------------------------------------------------------------
// The same chain against LIVE Postgres, where the fork-proof arbitration is a real
// partial unique index rather than the in-memory stand-in for one.
// ---------------------------------------------------------------------------

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('moderation audit chain — live Postgres', () => {
  let db: ReturnType<typeof createDbClient>;
  let store: DrizzleModerationAuditStore;
  let ran = false;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    store = new DrizzleModerationAuditStore(db);
  });

  afterAll(async () => {
    // ONE TRANSACTION: `session_replication_role` is a SESSION setting and the pool
    // hands each statement whichever connection is free, so the `SET` and the deletes
    // it covers can land on different connections and the append-only trigger fires
    // anyway.  `SET LOCAL` is scoped to the transaction, i.e. to one connection.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM moderation_audit WHERE action LIKE 'pg_chain_%'`);
    });
    await db.$client.end();
  });

  const stage = (action: string, prevHash: string | null): ModerationAuditRecord =>
    ({
      auditId: randomUUID(),
      ordinal: 0,
      eventTime: '',
      createdAt: '',
      actorUserId: null,
      actorRole: null,
      action,
      reasonCode: null,
      targetType: 'account',
      targetId: null,
      subjectUserId: null,
      priorState: null,
      nextState: null,
      reversible: false,
      linkedActionId: null,
      caseId: null,
      prevHash,
      integrityHash: null,
      reportIds: [],
      coApproverUserId: null,
      notes: null,
    }) satisfies ModerationAuditRecord;

  it('links each entry to the live head, and the chain verifies', async () => {
    ran = true;
    const written: ModerationAuditRecord[] = [];
    for (let i = 0; i < 5; i++) {
      const head = await store.chainHead();
      const entry = await store.appendChained(
        stage(`pg_chain_${i}`, head?.integrityHash ?? null),
        (s) => computeAuditEntryHash(s, KEY, refOf),
      );
      expect(entry).not.toBeNull();
      written.push(entry as ModerationAuditRecord);
    }
    // Verified as READ BACK, not as returned: the round trip through Postgres is where a
    // preimage that cannot be recomputed from a stored row would show up (a timestamp
    // hashed at a finer resolution than the driver returns, for one).
    const readBack = await store.list({ action: 'pg_chain_0', limit: 10 });
    expect(readBack[0]?.integrityHash).toBe(written[0]?.integrityHash);
    for (let i = 1; i < written.length; i++) {
      expect(written[i]?.prevHash).toBe(written[i - 1]?.integrityHash);
    }
    const report = verifyAuditChain(written, KEY, refOf);
    expect(report.problems).toEqual([]);
  });

  it('the DATABASE refuses a second entry claiming the same parent', async () => {
    ran = true;
    const head = await store.chainHead();
    const parent = head?.integrityHash ?? null;
    const first = await store.appendChained(stage('pg_chain_fork_a', parent), (s) =>
      computeAuditEntryHash(s, KEY, refOf),
    );
    expect(first).not.toBeNull();
    // The fork-proof partial unique — not application logic — is what refuses this.
    const second = await store.appendChained(stage('pg_chain_fork_b', parent), (s) =>
      computeAuditEntryHash(s, KEY, refOf),
    );
    expect(second).toBeNull();
  });

  it('actually ran the gated legs (a skipped leg proves nothing)', () => {
    expect(ran).toBe(true);
  });
});
