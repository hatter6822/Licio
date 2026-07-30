// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The electorate snapshot as ONE Postgres statement — see `electorate-basis.ts` for why
// it must be one, and why it returns facts rather than a verdict.
//
// Authoring notes, each of them a trap this repo has already been bitten by:
//
//   - NEVER a VIEW or MATERIALIZED VIEW. `buildAdjacency` in `packages/db/src/isolation.ts`
//     turns a view's dependencies into UNDIRECTED graph edges, so a view joining the
//     ranking-context `room_subscriptions`/`room_stewards` to the compliance and wallet
//     BFS seeds would join the two contexts the wallet↔ranking isolation proof exists to
//     keep apart. An inline statement is invisible to that walk, which reads foreign keys
//     and `information_schema.view_table_usage` only.
//   - `now()` is the TRANSACTION timestamp, so it is stable for the whole statement and
//     is the instant the returned facts describe. That is the entire exactness argument.
//   - Written as a raw template rather than the query builder: the statement spans four
//     schemas (`public`, `compliance`, `wallet`, `knomosis`) and Drizzle renders an
//     interpolated table as `"schema"."table"."col"`, which Postgres rejects against a
//     CTE alias. The names are pinned by `electorate-basis-contract.test.ts` running the
//     REAL migration chain, not by being typed.
import type { DbExecutor } from '@licio/db';
import { sql } from 'drizzle-orm';
import { READINESS_QUALIFYING_AUDIT_ACTIONS } from '../knomosis/stores.js';
import type {
  ElectorateBasisStore,
  ElectorateMemberFacts,
  ElectorateSnapshot,
} from './electorate-basis.js';

interface Row {
  as_of: string;
  user_id: string;
  subscribed: boolean;
  joined_at: string | null;
  requested_at: string | null;
  account_state: string | null;
  age_band: string | null;
  email_verified: boolean;
  email_verified_at: string | null;
  has_verified_credential: boolean;
  kyc_verified: boolean;
  has_compliance_hold: boolean;
  has_high_risk_wallet: boolean;
  contribution_count: number;
}

export class DrizzleElectorateBasisStore implements ElectorateBasisStore {
  readonly #db: DbExecutor;
  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async snapshot(roomId: string, asOf?: string): Promise<ElectorateSnapshot> {
    // `IN (…)` over joined placeholders, NOT `= ANY($1::text[])`: Drizzle interpolates a
    // JS array as a record, and Postgres refuses to cast a record to text[]. The values
    // are a module constant, so each is still a bound parameter.
    const actions = sql.join(
      [...READINESS_QUALIFYING_AUDIT_ACTIONS].map((a) => sql`${a}`),
      sql`, `,
    );
    // `coalesce($asOf, now())` rather than two statements: the cutoff and the stamp are
    // then the SAME value even on the freeze path, which is the property the whole
    // snapshot exists to have.
    const cutoff = sql`coalesce(${asOf ?? null}::timestamptz, now())`;
    const rows = (await this.#db.execute(sql`
      WITH roster AS (
        SELECT r.user_id,
               max(r.joined_at)      AS joined_at,
               max(r.requested_at)   AS requested_at,
               bool_or(r.subscribed) AS subscribed
          FROM (
            SELECT s.user_id, s.joined_at, s.requested_at, true AS subscribed
              FROM room_subscriptions s
             WHERE s.room_id = ${roomId}::uuid AND s.status = 'active'
               -- Only exclude a member we KNOW joined after the instant: an unknown join
               -- is unjudgeable, and the ballot gate lets that through too.
               AND (s.joined_at IS NULL OR s.joined_at <= ${cutoff})
            UNION ALL
            -- A PER-ROOM steward grant, which carries no join instant and needs none.
            SELECT st.user_id, NULL::timestamptz, NULL::timestamptz, false
              FROM room_stewards st WHERE st.room_id = ${roomId}::uuid
          ) r GROUP BY r.user_id
      )
      SELECT ${cutoff}::text AS as_of,
             roster.user_id::text AS user_id,
             roster.subscribed,
             roster.joined_at::text    AS joined_at,
             roster.requested_at::text AS requested_at,
             u.account_state::text     AS account_state,
             u.age_band_if_known::text AS age_band,
             coalesce(ua.email_verified, false) AS email_verified,
             ua.email_verified_at::text AS email_verified_at,
             (coalesce(ua.email_verified, false)
               OR EXISTS (SELECT 1 FROM webauthn_credentials w WHERE w.user_id = roster.user_id)
               OR EXISTS (SELECT 1 FROM wallet_auth_credentials wa WHERE wa.user_id = roster.user_id)
             ) AS has_verified_credential,
             -- COALESCED.  A member with no kyc_verification row leaves kv.status NULL,
             -- and NULL = 'verified' is NULL rather than false — so this column came back
             -- null where the in-memory twin said false.  The contract suite caught that
             -- on its first run against live Postgres, which is why it exists.
             coalesce(kv.status = 'verified', false) AS kyc_verified,
             -- The SAME anti-tipping-off shape the availability engine uses: a suppressed
             -- lawful-access case must not create a visible hold, or the refusal reveals
             -- what counsel has not permitted the member to be told.
             EXISTS (
               SELECT 1 FROM compliance.financial_compliance_case c
                WHERE c.user_id_or_room_id = roster.user_id::text
                  AND c.subject_kind = 'user'
                  AND c.review_state <> 'resolved'
                  AND c.risk_level IN ('high','critical')
                  AND NOT EXISTS (
                    SELECT 1 FROM compliance.lawful_access_request l
                     WHERE l.case_id = c.case_id
                       AND l.scope->>'subject_ref' = roster.user_id::text
                       AND l.user_notified_at IS NULL
                       AND l.status <> 'denied')
             ) AS has_compliance_hold,
             -- '<> finalized', NOT '= active': a pending unlink is still a live link,
             -- and listByUser(userId, false) is what the ballot gate reads.
             EXISTS (
               SELECT 1 FROM wallet.wallet_accounts wl
                WHERE wl.user_id = roster.user_id
                  AND wl.unlink_state <> 'finalized'
                  AND wl.risk_state = 'high'
             ) AS has_high_risk_wallet,
             (SELECT count(*)::int FROM knomosis.governance_audit_log g
               WHERE g.room_id = ${roomId}::uuid
                 AND g.actor_user_id = roster.user_id
                 AND g.action_type IN (${actions})
                 AND g.created_at <= ${cutoff}) AS contribution_count
        FROM roster
        LEFT JOIN users     u  ON u.user_id  = roster.user_id
        LEFT JOIN user_auth ua ON ua.user_id = roster.user_id
        LEFT JOIN compliance.kyc_verification kv ON kv.user_id = roster.user_id
       ORDER BY roster.user_id
    `)) as unknown as Row[];
    const members: ElectorateMemberFacts[] = rows.map((r) => ({
      userId: r.user_id,
      subscribed: r.subscribed,
      joinedAt: r.joined_at,
      requestedAt: r.requested_at,
      accountState: r.account_state,
      ageBand: (r.age_band as ElectorateMemberFacts['ageBand']) ?? null,
      emailVerified: r.email_verified,
      emailVerifiedAt: r.email_verified_at,
      hasVerifiedCredential: r.has_verified_credential,
      kycVerified: r.kyc_verified,
      hasComplianceHold: r.has_compliance_hold,
      hasHighRiskWallet: r.has_high_risk_wallet,
      contributionCount: r.contribution_count,
    }));
    // One row's `as_of` is every row's — it is the statement's own clock.
    const asOfOut = rows[0]?.as_of ?? asOf ?? new Date().toISOString();
    return { asOf: new Date(asOfOut).toISOString(), members };
  }
}
