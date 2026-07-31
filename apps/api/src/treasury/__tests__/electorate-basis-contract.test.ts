// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE CONTRACT, BOTH ADAPTERS.
//
// The electorate snapshot is one Postgres statement in production and a fold over Maps in
// tests. That asymmetry is the whole risk: a predicate written from the Drizzle semantics
// and mirrored by hand in the in-memory twin is two spellings, and the divergence would
// pass every unit test and surface only against a live database.
//
// So the fixture and the expectations live in ONE function, invoked twice — once
// in-memory, once under `describe.skipIf(!DATABASE_URL)` against live Postgres with the
// REAL migration chain. Anything the two disagree about fails here.
//
// The gated leg carries a hard "it ran" assertion, because a silently skipped leg proves
// nothing and reads exactly like a passing one.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleElectorateBasisStore } from '../drizzle-electorate-basis.js';
import { type ElectorateBasisStore, InMemoryElectorateBasisStore } from '../electorate-basis.js';

const DB_URL = process.env['DATABASE_URL'];

/** The matrix every adapter must agree on. */
interface Member {
  readonly key: string;
  readonly subscribed: boolean;
  readonly steward: boolean;
  readonly ageBand: 'adult' | 'teen_16_17' | null;
  readonly accountState: 'active' | 'restricted' | 'suspended';
  readonly emailVerified: boolean;
  readonly kycVerified: boolean;
  readonly hold: boolean;
  /** A hold that IS suppressed by an unnotified lawful-access request — must NOT count. */
  readonly suppressedHold: boolean;
  readonly highRiskWallet: boolean;
  /** A non-finalized but PENDING-unlink high-risk wallet — still a live link. */
  readonly pendingUnlinkHighRisk: boolean;
}

const MATRIX: readonly Member[] = [
  {
    key: 'plain',
    subscribed: true,
    steward: false,
    ageBand: 'adult',
    accountState: 'active',
    emailVerified: true,
    kycVerified: true,
    hold: false,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'steward_only',
    subscribed: false,
    steward: true,
    ageBand: 'adult',
    accountState: 'active',
    emailVerified: true,
    kycVerified: true,
    hold: false,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'teen',
    subscribed: true,
    steward: false,
    ageBand: 'teen_16_17',
    accountState: 'active',
    emailVerified: true,
    kycVerified: true,
    hold: false,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'age_unknown',
    subscribed: true,
    steward: false,
    ageBand: null,
    accountState: 'active',
    emailVerified: true,
    kycVerified: true,
    hold: false,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'restricted',
    subscribed: true,
    steward: false,
    ageBand: 'adult',
    accountState: 'restricted',
    emailVerified: true,
    kycVerified: true,
    hold: false,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'unverified',
    subscribed: true,
    steward: false,
    ageBand: 'adult',
    accountState: 'active',
    emailVerified: false,
    kycVerified: true,
    hold: false,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'no_kyc',
    subscribed: true,
    steward: false,
    ageBand: 'adult',
    accountState: 'active',
    emailVerified: true,
    kycVerified: false,
    hold: false,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'held',
    subscribed: true,
    steward: false,
    ageBand: 'adult',
    accountState: 'active',
    emailVerified: true,
    kycVerified: true,
    hold: true,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'held_but_suppressed',
    subscribed: true,
    steward: false,
    ageBand: 'adult',
    accountState: 'active',
    emailVerified: true,
    kycVerified: true,
    hold: true,
    suppressedHold: true,
    highRiskWallet: false,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'risky_wallet',
    subscribed: true,
    steward: false,
    ageBand: 'adult',
    accountState: 'active',
    emailVerified: true,
    kycVerified: true,
    hold: false,
    suppressedHold: false,
    highRiskWallet: true,
    pendingUnlinkHighRisk: false,
  },
  {
    key: 'pending_unlink_risky',
    subscribed: true,
    steward: false,
    ageBand: 'adult',
    accountState: 'active',
    emailVerified: true,
    kycVerified: true,
    hold: false,
    suppressedHold: false,
    highRiskWallet: false,
    pendingUnlinkHighRisk: true,
  },
];

/** What the snapshot must say about a member, whichever adapter answered. */
function expected(m: Member) {
  return {
    subscribed: m.subscribed,
    ageBand: m.ageBand,
    accountState: m.accountState,
    emailVerified: m.emailVerified,
    hasVerifiedCredential: m.emailVerified,
    kycVerified: m.kycVerified,
    // A SUPPRESSED lawful-access case must not surface as a hold: the refusal would
    // otherwise reveal what counsel has not permitted the member to be told.
    hasComplianceHold: m.hold && !m.suppressedHold,
    // `<> 'finalized'` — a PENDING unlink is still a live link, which is what
    // `listByUser(userId, false)` reads on the ballot side.
    hasHighRiskWallet: m.highRiskWallet || m.pendingUnlinkHighRisk,
  };
}

/** The suite both adapters run. */
function contract(
  label: string,
  make: () => Promise<{ store: ElectorateBasisStore; roomId: string; idOf: (k: string) => string }>,
  ran?: { yes: boolean },
): void {
  describe(label, () => {
    it('reports the same facts for every member of the matrix', async () => {
      if (ran) ran.yes = true;
      const { store, roomId, idOf } = await make();
      const snap = await store.snapshot(roomId);
      expect(snap.members).toHaveLength(MATRIX.length);
      // The instant is the snapshot's own, and every row shares it.
      expect(Number.isNaN(Date.parse(snap.asOf))).toBe(false);
      const byId = new Map(snap.members.map((row) => [row.userId, row]));
      for (const m of MATRIX) {
        const row = byId.get(idOf(m.key));
        expect(row, `${m.key} present`).toBeDefined();
        expect({ ...expected(m) }, m.key).toEqual({
          subscribed: row?.subscribed,
          ageBand: row?.ageBand,
          accountState: row?.accountState,
          emailVerified: row?.emailVerified,
          hasVerifiedCredential: row?.hasVerifiedCredential,
          kycVerified: row?.kycVerified,
          hasComplianceHold: row?.hasComplianceHold,
          hasHighRiskWallet: row?.hasHighRiskWallet,
        });
      }
    });

    it('a steward-only member carries no subscription instants', async () => {
      // `memberFacts` answers null for them, and the fold depends on telling the two
      // apart — a per-room grant is a governance member without an active subscription.
      const { store, roomId, idOf } = await make();
      const snap = await store.snapshot(roomId);
      const row = snap.members.find((r) => r.userId === idOf('steward_only'));
      expect(row?.subscribed).toBe(false);
      expect(row?.joinedAt).toBeNull();
      expect(row?.requestedAt).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------
const memIds = new Map(MATRIX.map((m) => [m.key, `mem-${m.key}`]));

contract('electorate snapshot — in-memory', async () => {
  const roomId = 'room-1';
  const find = (id: string) => MATRIX.find((m) => `mem-${m.key}` === id);
  const store = new InMemoryElectorateBasisStore({
    roster: async () => MATRIX.map((m) => `mem-${m.key}`),
    subscription: async (_room, userId) => {
      const m = find(userId);
      return m?.subscribed === true
        ? { status: 'active', joinedAt: null, requestedAt: '2026-01-01T00:00:00.000Z' }
        : null;
    },
    account: async (userId) => {
      const m = find(userId);
      return { accountState: m?.accountState ?? null, ageBand: m?.ageBand ?? null };
    },
    auth: async (userId) => ({ emailVerified: find(userId)?.emailVerified === true }),
    hasVerifiedCredential: async (userId) => find(userId)?.emailVerified === true,
    kycVerified: async (userId) => find(userId)?.kycVerified === true,
    hasComplianceHold: async (userId) => {
      const m = find(userId);
      return m?.hold === true && m.suppressedHold !== true;
    },
    hasHighRiskWallet: async (userId) => {
      const m = find(userId);
      return m?.highRiskWallet === true || m?.pendingUnlinkHighRisk === true;
    },
    contributionCount: async () => 0,
    now: () => Date.parse('2026-07-30T00:00:00.000Z'),
  });
  return { store, roomId, idOf: (k: string) => memIds.get(k) as string };
});

// ---------------------------------------------------------------------------
// Live Postgres — the leg that proves the SQL, not the description of it
// ---------------------------------------------------------------------------
const gatedRan = { yes: false };

describe.skipIf(!DB_URL)('electorate snapshot — live Postgres', () => {
  let db: ReturnType<typeof createDbClient>;
  let roomId: string;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    roomId = randomUUID();
    await db.execute(sql`
      insert into rooms (room_id, slug, name, room_type, visibility, join_model)
      values (${roomId}, ${`eb-${roomId.slice(0, 8)}`}, 'Electorate basis',
              'global_topic', 'public', 'open')`);
    for (const m of MATRIX) {
      const userId = randomUUID();
      ids.set(m.key, userId);
      await db.execute(sql`
        insert into users
          (user_id, handle, display_name, privacy_settings, personalization_settings,
           account_state, age_band_if_known)
        values (${userId}, ${`eb_${m.key}_${userId.slice(0, 6)}`}, ${m.key},
                '{}'::jsonb, '{}'::jsonb,
                ${m.accountState}::account_state,
                ${m.ageBand}::age_band_if_known)`);
      await db.execute(sql`
        insert into user_auth (user_id, email_verified)
        values (${userId}, ${m.emailVerified})`);
      if (m.subscribed) {
        await db.execute(sql`
          insert into room_subscriptions (room_id, user_id, status, request_id, requested_at)
          values (${roomId}, ${userId}, 'active', ${randomUUID()}, now())`);
      }
      if (m.steward) {
        await db.execute(sql`
          insert into room_stewards (room_id, user_id, role)
          values (${roomId}, ${userId}, 'community_steward')`);
      }
      if (m.kycVerified) {
        await db.execute(sql`
          insert into compliance.kyc_verification (user_id, status)
          values (${userId}, 'verified')`);
      }
      if (m.hold) {
        const caseId = randomUUID();
        await db.execute(sql`
          insert into compliance.financial_compliance_case
            (case_id, user_id_or_room_id, subject_kind, trigger_type, risk_level,
             review_state, retention_policy)
          values (${caseId}, ${userId}, 'user', 'manual', 'high', 'open', '{}'::jsonb)`);
        if (m.suppressedHold) {
          await db.execute(sql`
            insert into compliance.lawful_access_request
              (request_id, agency, jurisdiction, legal_basis, scope, contact, status, case_id)
            values (${randomUUID()}, 'agency', 'US', ${'subpoena'},
                    jsonb_build_object('subject_ref', ${userId}::text),
                    'contact', 'received', ${caseId})`);
        }
      }
      if (m.highRiskWallet || m.pendingUnlinkHighRisk) {
        await db.execute(sql`
          insert into wallet.wallet_accounts
            (wallet_account_id, user_id, address_hash, address_truncated, chain_id,
             wallet_type, unlink_state, risk_state)
          values (${randomUUID()}, ${userId},
                  decode(${randomUUID().replaceAll('-', '').padEnd(64, '0')}, 'hex'),
                  '0xabcd…4321', 1337, 'eoa',
                  ${m.pendingUnlinkHighRisk ? 'pending_unlink' : 'active'}::wallet.unlink_state,
                  'high'::wallet.wallet_risk_state)`);
      }
    }
  });

  afterAll(async () => {
    await db.execute(sql`delete from rooms where room_id = ${roomId}`);
    await db.$client.end();
  });

  contract(
    'the statement',
    async () => ({
      store: new DrizzleElectorateBasisStore(db),
      roomId,
      idOf: (k: string) => ids.get(k) as string,
    }),
    gatedRan,
  );
});

describe('the gated leg is not silently skipped', () => {
  it('ran against live Postgres when DATABASE_URL is set', () => {
    // A skipped gated leg reads exactly like a passing one, and this suite's whole value
    // is the SQL it exercises. If the environment has a database, the leg must have run.
    if (DB_URL) expect(gatedRan.yes).toBe(true);
    else expect(gatedRan.yes).toBe(false);
  });
});
