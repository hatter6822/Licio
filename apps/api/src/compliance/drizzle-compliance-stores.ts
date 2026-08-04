// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the WS-N compliance stores, behind the
// SAME interfaces as the in-memory adapters in `stores.ts` (the house
// policy: the Postgres drop-in is transparent).  Covered by the gated
// integration test that runs the real migration chain.
//
// Parity with the schema's protections:
//   • The two audit chains are APPEND-ONLY here too — the only write path is
//     `appendChained()` (INSERT); a fork (parent/genesis collision on the
//     partial uniques) maps SQLSTATE 23505 to `null` so the shared chain
//     engine retries against the new head.
//   • Retention deletion runs inside ONE transaction that sets the
//     sanctioned `licio.compliance_retention` GUC (the trigger's key), trail
//     first, then the case — "deletion is thorough" without ever exposing a
//     casual DELETE path.
//   • The right-to-erasure scrub NULLs user subjects EXCEPT under a legal
//     hold (the audited carve-out), exactly like the in-memory adapter.

import {
  complianceCaseAudits,
  type createDbClient,
  disclosureAcknowledgments,
  disclosureVersions,
  financialComplianceCases,
  jurisdictionFeaturePolicies,
  jurisdictionPolicyAudits,
  kycVerifications,
  lawfulAccessRequests,
  regionDeclarations,
  sarReports,
  walletRiskPins,
} from '@licio/db';
import type {
  CaseResolution,
  CaseRetentionPolicy,
  CaseReviewState,
  CaseRiskLevel,
  CaseSubjectKind,
  CaseTriggerType,
  LawfulAccessStatus,
  SarStatus,
} from '@licio/shared';
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import { DrizzlePwattConfigStore } from '../events/drizzle-event-stores.js';
import { DrizzleAuditStore } from '../identity/drizzle-store.js';
import { isUniqueViolation } from '../lib/pg-errors.js';
import type {
  CaseAuditRecord,
  CaseAuditStore,
  ComplianceCaseRecord,
  ComplianceCaseStore,
  ComplianceTransactor,
  ComplianceTxStores,
  DeclarationPremises,
  DisclosureAckRecord,
  DisclosureAckStore,
  DisclosureStore,
  DisclosureVersionRecord,
  JurisdictionPolicyRow,
  JurisdictionPolicyStore,
  KycPremises,
  KycVerificationRecord,
  KycVerificationStore,
  LawfulAccessRecord,
  LawfulAccessStore,
  PolicyAuditRecord,
  PolicyAuditStore,
  RegionDeclarationRecord,
  RegionDeclarationStore,
  SarRecord,
  SarStore,
  WalletRiskPinRecord,
  WalletRiskPinStore,
} from './stores.js';
import { nextHoldPolicy } from './stores.js';

type Db = ReturnType<typeof createDbClient>;
/** The handle inside `db.transaction(...)`.  Every store here takes `Db | Tx`
 *  so the SAME class serves an autocommit call and a unit of work — there is
 *  no second, transaction-only copy of the queries to drift. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/**
 * A store may be built over the POOL or over a caller's TRANSACTION — and this
 * type cannot tell you which you got.  That is the whole hazard:
 *
 *   • handed a `Tx`, a method's statements are atomic (the caller's unit);
 *   • handed the pool, EACH STATEMENT IS ITS OWN TRANSACTION, so the same code
 *     silently races and a `SELECT … FOR UPDATE` releases its lock the instant
 *     its statement ends.
 *
 * So the rule, and it is not optional: **a method that issues more than one
 * statement must open its own transaction** (`this.#db.transaction(...)` — a
 * SAVEPOINT when nested, a real transaction on the pool, correct either way).
 * Atomicity is the method's promise to make; it cannot be delegated to whoever
 * happened to construct the store.
 *
 * `applyLegalHold` learned this the expensive way: its row lock was correct for
 * every production caller (all inside a unit) and worthless for a direct one,
 * and only CI's gated Postgres run ever saw the lost update.
 * `drizzle-store-atomicity.test.ts` now enforces the rule statically.
 */
type DbOrTx = Db | Tx;

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value === null ? null : iso(value));

// ---------------------------------------------------------------------------
// Jurisdiction policies (WS-N.1.1a).
// ---------------------------------------------------------------------------

type PolicyRowDb = typeof jurisdictionFeaturePolicies.$inferSelect;

function toPolicyRow(row: PolicyRowDb): JurisdictionPolicyRow {
  return {
    policyId: row.policyId,
    countryOrRegion: row.countryOrRegion,
    effectiveAt: iso(row.effectiveAt),
    // The RAW document reassembled from the columns; the engine re-validates.
    document: {
      policy_id: row.policyId,
      country_or_region: row.countryOrRegion,
      feature_flags: row.featureFlags,
      asset_flags: row.assetFlags,
      age_gate_policy: row.ageGatePolicy,
      kyc_policy: row.kycPolicy,
      disclosure_refs: row.disclosureRefs,
      legal_approval_ref: row.legalApprovalRef,
      effective_at: iso(row.effectiveAt),
    },
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleJurisdictionPolicyStore implements JurisdictionPolicyStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async insert(row: JurisdictionPolicyRow): Promise<JurisdictionPolicyRow> {
    const document = row.document as Record<string, unknown>;
    const rows = await this.#db
      .insert(jurisdictionFeaturePolicies)
      .values({
        policyId: row.policyId,
        countryOrRegion: row.countryOrRegion,
        featureFlags: document['feature_flags'],
        assetFlags: document['asset_flags'],
        ageGatePolicy: document['age_gate_policy'],
        kycPolicy: document['kyc_policy'],
        disclosureRefs: document['disclosure_refs'],
        legalApprovalRef: (document['legal_approval_ref'] as string | null) ?? null,
        effectiveAt: new Date(row.effectiveAt),
      })
      .returning();
    const inserted = rows[0];
    if (inserted === undefined) throw new Error('jurisdiction policy insert returned no row');
    return toPolicyRow(inserted);
  }

  async activeForRegion(region: string, nowIso: string): Promise<JurisdictionPolicyRow | null> {
    const rows = await this.#db
      .select()
      .from(jurisdictionFeaturePolicies)
      .where(
        and(
          eq(jurisdictionFeaturePolicies.countryOrRegion, region),
          lte(jurisdictionFeaturePolicies.effectiveAt, new Date(nowIso)),
        ),
      )
      .orderBy(desc(jurisdictionFeaturePolicies.effectiveAt))
      .limit(1);
    return rows[0] ? toPolicyRow(rows[0]) : null;
  }

  async hasOnlyFutureRows(region: string, nowIso: string): Promise<boolean> {
    const future = await this.#db
      .select({ policyId: jurisdictionFeaturePolicies.policyId })
      .from(jurisdictionFeaturePolicies)
      .where(
        and(
          eq(jurisdictionFeaturePolicies.countryOrRegion, region),
          gt(jurisdictionFeaturePolicies.effectiveAt, new Date(nowIso)),
        ),
      )
      .limit(1);
    if (future.length === 0) return false;
    const effective = await this.#db
      .select({ policyId: jurisdictionFeaturePolicies.policyId })
      .from(jurisdictionFeaturePolicies)
      .where(
        and(
          eq(jurisdictionFeaturePolicies.countryOrRegion, region),
          lte(jurisdictionFeaturePolicies.effectiveAt, new Date(nowIso)),
        ),
      )
      .limit(1);
    return effective.length === 0;
  }

  async listByRegion(region: string): Promise<JurisdictionPolicyRow[]> {
    const rows = await this.#db
      .select()
      .from(jurisdictionFeaturePolicies)
      .where(eq(jurisdictionFeaturePolicies.countryOrRegion, region))
      .orderBy(asc(jurisdictionFeaturePolicies.effectiveAt));
    return rows.map(toPolicyRow);
  }

  async listAll(): Promise<JurisdictionPolicyRow[]> {
    const rows = await this.#db
      .select()
      .from(jurisdictionFeaturePolicies)
      .orderBy(asc(jurisdictionFeaturePolicies.countryOrRegion));
    return rows.map(toPolicyRow);
  }
}

// ---------------------------------------------------------------------------
// The policy change chain (WS-N.1.1g) — append-only, fork-proof.
// ---------------------------------------------------------------------------

type PolicyAuditRowDb = typeof jurisdictionPolicyAudits.$inferSelect;

function toPolicyAudit(row: PolicyAuditRowDb): PolicyAuditRecord {
  return {
    changeId: row.changeId,
    policyId: row.policyId,
    countryOrRegion: row.countryOrRegion,
    changeType: row.changeType as PolicyAuditRecord['changeType'],
    changedByRef: row.changedByRef,
    previousValue: row.previousValue,
    newValue: row.newValue,
    reason: row.reason,
    approvalRef: row.approvalRef,
    prevHash: row.prevHash,
    integrityHash: row.integrityHash,
    createdAt: iso(row.createdAt),
  };
}

export class DrizzlePolicyAuditStore implements PolicyAuditStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async chainHead(): Promise<PolicyAuditRecord | null> {
    // The head is the entry whose hash no other entry references as parent —
    // unique by the fork-proof indexes (never an ordering heuristic).
    const rows = await this.#db
      .select()
      .from(jurisdictionPolicyAudits)
      .where(
        sql`${jurisdictionPolicyAudits.integrityHash} NOT IN (
          SELECT jpa."prev_hash" FROM "compliance"."jurisdiction_policy_audit" jpa
          WHERE jpa."prev_hash" IS NOT NULL
        )`,
      )
      .limit(1);
    return rows[0] ? toPolicyAudit(rows[0]) : null;
  }

  async appendChained(entry: PolicyAuditRecord): Promise<PolicyAuditRecord | null> {
    try {
      const rows = await this.#db
        .insert(jurisdictionPolicyAudits)
        .values({
          changeId: entry.changeId,
          policyId: entry.policyId,
          countryOrRegion: entry.countryOrRegion,
          changeType: entry.changeType,
          changedByRef: entry.changedByRef,
          previousValue: entry.previousValue,
          newValue: entry.newValue,
          reason: entry.reason,
          approvalRef: entry.approvalRef,
          prevHash: entry.prevHash,
          integrityHash: entry.integrityHash,
          createdAt: new Date(entry.createdAt),
        })
        .returning();
      const row = rows[0];
      return row ? toPolicyAudit(row) : null;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // fork → the engine retries
      throw error;
    }
  }

  async listChained(): Promise<PolicyAuditRecord[]> {
    const rows = await this.#db
      .select()
      .from(jurisdictionPolicyAudits)
      .orderBy(asc(jurisdictionPolicyAudits.createdAt));
    return rows.map(toPolicyAudit);
  }
}

// ---------------------------------------------------------------------------
// Financial-compliance cases (WS-N.2.1a).
// ---------------------------------------------------------------------------

/**
 * "This case is PROVABLY not under a legal hold."  ONE definition, shared by
 * the sweep's `listExpired` selection and by the retention WRITES themselves —
 * the writes must re-assert it, because a hold applied in the gap between the
 * two would otherwise anonymize or delete records a fresh SAR or lawful-access
 * request now protects (WS-N.2.1a/d).
 *
 * `= false`, not `IS NOT TRUE`: an absent or null `legal_hold` reads as NULL,
 * and `NULL = false` is NULL, so a row whose policy cannot be read is neither
 * selected nor written.  That is the fail-closed direction for a destructive
 * act — "not provably unheld" must not authorize a delete.
 */
const NOT_HELD = sql`(${financialComplianceCases.retentionPolicy}->>'legal_hold')::boolean = false`;

type CaseRowDb = typeof financialComplianceCases.$inferSelect;

function toCaseRecord(row: CaseRowDb): ComplianceCaseRecord {
  return {
    caseId: row.caseId,
    userIdOrRoomId: row.userIdOrRoomId,
    subjectKind: row.subjectKind,
    triggerType: row.triggerType,
    riskLevel: row.riskLevel,
    partnerCaseRef: row.partnerCaseRef,
    reviewState: row.reviewState,
    assignedTo: row.assignedTo,
    resolution: (row.resolution as CaseResolution | null) ?? null,
    retentionPolicy: row.retentionPolicy as CaseRetentionPolicy,
    idempotencyKey: row.idempotencyKey,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleComplianceCaseStore implements ComplianceCaseStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async insert(record: ComplianceCaseRecord): Promise<ComplianceCaseRecord> {
    // ON CONFLICT DO NOTHING, never catch-and-query: inside a unit of work a
    // raised unique violation ABORTS the transaction, so the follow-up read
    // for the winner would fail and take an idempotent duplicate — the whole
    // point of the key — down with it as a 503.  Conflicting quietly keeps the
    // transaction healthy enough to go find the row that won.
    const rows = await this.#db
      .insert(financialComplianceCases)
      .values({
        caseId: record.caseId,
        userIdOrRoomId: record.userIdOrRoomId,
        subjectKind: record.subjectKind,
        triggerType: record.triggerType,
        riskLevel: record.riskLevel,
        partnerCaseRef: record.partnerCaseRef,
        reviewState: record.reviewState,
        assignedTo: record.assignedTo,
        resolution: record.resolution,
        retentionPolicy: record.retentionPolicy,
        idempotencyKey: record.idempotencyKey,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (row !== undefined) return toCaseRecord(row);
    // No row inserted ⇒ the idempotency slot is taken; theirs is THE case.
    if (record.idempotencyKey !== null) {
      const existing = await this.findByIdempotencyKey(record.idempotencyKey);
      if (existing !== null) return existing;
    }
    throw new Error('compliance case insert returned no row');
  }

  async getById(caseId: string): Promise<ComplianceCaseRecord | null> {
    const rows = await this.#db
      .select()
      .from(financialComplianceCases)
      .where(eq(financialComplianceCases.caseId, caseId))
      .limit(1);
    return rows[0] ? toCaseRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<ComplianceCaseRecord | null> {
    const rows = await this.#db
      .select()
      .from(financialComplianceCases)
      .where(eq(financialComplianceCases.idempotencyKey, key))
      .limit(1);
    return rows[0] ? toCaseRecord(rows[0]) : null;
  }

  async listByStates(
    states: readonly CaseReviewState[],
    limit: number,
  ): Promise<ComplianceCaseRecord[]> {
    const rows = await this.#db
      .select()
      .from(financialComplianceCases)
      .where(inArray(financialComplianceCases.reviewState, [...states]))
      .orderBy(asc(financialComplianceCases.createdAt))
      .limit(limit);
    return rows.map(toCaseRecord);
  }

  async listBySubject(
    subjectRef: string,
    subjectKind: CaseSubjectKind,
    limit: number,
    offset = 0,
  ): Promise<ComplianceCaseRecord[]> {
    const rows = await this.#db
      .select()
      .from(financialComplianceCases)
      .where(
        and(
          eq(financialComplianceCases.userIdOrRoomId, subjectRef),
          // KIND-matched: the ref is polymorphic and manual/lawful-access cases
          // are not FK-constrained (see the in-memory adapter).
          eq(financialComplianceCases.subjectKind, subjectKind),
        ),
      )
      .orderBy(desc(financialComplianceCases.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map(toCaseRecord);
  }

  async transition(
    caseId: string,
    fromState: CaseReviewState,
    patch: Partial<
      Pick<
        ComplianceCaseRecord,
        'reviewState' | 'assignedTo' | 'resolution' | 'retentionPolicy' | 'partnerCaseRef'
      >
    >,
    updatedAt: string,
  ): Promise<ComplianceCaseRecord | null> {
    const rows = await this.#db
      .update(financialComplianceCases)
      .set({
        ...(patch.reviewState !== undefined ? { reviewState: patch.reviewState } : {}),
        ...(patch.assignedTo !== undefined ? { assignedTo: patch.assignedTo } : {}),
        ...(patch.resolution !== undefined ? { resolution: patch.resolution } : {}),
        ...(patch.retentionPolicy !== undefined ? { retentionPolicy: patch.retentionPolicy } : {}),
        ...(patch.partnerCaseRef !== undefined ? { partnerCaseRef: patch.partnerCaseRef } : {}),
        updatedAt: new Date(updatedAt),
      })
      .where(
        and(
          eq(financialComplianceCases.caseId, caseId),
          eq(financialComplianceCases.reviewState, fromState),
        ),
      )
      .returning();
    return rows[0] ? toCaseRecord(rows[0]) : null;
  }

  async update(
    caseId: string,
    patch: Partial<Pick<ComplianceCaseRecord, 'retentionPolicy' | 'partnerCaseRef'>>,
    updatedAt: string,
  ): Promise<ComplianceCaseRecord | null> {
    const rows = await this.#db
      .update(financialComplianceCases)
      .set({
        ...(patch.retentionPolicy !== undefined ? { retentionPolicy: patch.retentionPolicy } : {}),
        ...(patch.partnerCaseRef !== undefined ? { partnerCaseRef: patch.partnerCaseRef } : {}),
        updatedAt: new Date(updatedAt),
      })
      .where(eq(financialComplianceCases.caseId, caseId))
      .returning();
    return rows[0] ? toCaseRecord(rows[0]) : null;
  }

  async listExpired(nowIso: string, limit: number): Promise<ComplianceCaseRecord[]> {
    const rows = await this.#db
      .select()
      .from(financialComplianceCases)
      .where(
        and(
          NOT_HELD,
          // An already-anonymized case has discharged its retention action:
          // its deletion date stays in the past forever, so without this it
          // would be re-selected and re-anonymized on every sweep round.
          sql`(${financialComplianceCases.retentionPolicy}->>'anonymized_at') IS NULL`,
          sql`(${financialComplianceCases.retentionPolicy}->>'deletion_date') <= ${nowIso}`,
        ),
      )
      .limit(limit);
    return rows.map(toCaseRecord);
  }

  async listByStatesAndTriggers(
    states: readonly CaseReviewState[],
    triggers: readonly CaseTriggerType[],
    limit: number,
  ): Promise<ComplianceCaseRecord[]> {
    if (triggers.length === 0) return [];
    const rows = await this.#db
      .select()
      .from(financialComplianceCases)
      .where(
        and(
          inArray(financialComplianceCases.reviewState, [...states]),
          // The trigger filter is part of the QUERY, so the cap below bounds
          // fraud-class cases — not whichever cases happen to sort first.
          inArray(financialComplianceCases.triggerType, [...triggers]),
        ),
      )
      .orderBy(asc(financialComplianceCases.createdAt))
      .limit(limit);
    return rows.map(toCaseRecord);
  }

  async countOpenByRisk(
    subjectRef: string,
    subjectKind: CaseSubjectKind,
    risks: readonly CaseRiskLevel[],
    excludeCaseIds: readonly string[] = [],
  ): Promise<number> {
    if (risks.length === 0) return 0;
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(financialComplianceCases)
      .where(
        and(
          eq(financialComplianceCases.userIdOrRoomId, subjectRef),
          // KIND-matched (see `listBySubject`): the user's hold must not count a
          // room/transaction case whose soft ref equals their id.
          eq(financialComplianceCases.subjectKind, subjectKind),
          sql`${financialComplianceCases.reviewState} <> 'resolved'`,
          inArray(financialComplianceCases.riskLevel, [...risks]),
          ...(excludeCaseIds.length > 0
            ? [notInArray(financialComplianceCases.caseId, [...excludeCaseIds])]
            : []),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async deleteCascade(caseId: string): Promise<boolean> {
    // ONE transaction under the sanctioned retention GUC: trail, then case.
    // A SAR reference makes the case DELETE itself fail (FK RESTRICT).
    return await this.#db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('licio.compliance_retention', 'on', true)`);
      // Re-read the hold under a ROW LOCK before removing anything.  The
      // sweep's `listExpired` read cannot carry this: a SAR draft or a
      // lawful-access intake can apply a hold in the gap between choosing the
      // page and deleting the row.  Locking closes the gap in both directions —
      // a hold-setter that got here first is visible to us, and one arriving
      // now waits for our commit and then finds the case gone.
      const live = await tx
        .select({ caseId: financialComplianceCases.caseId })
        .from(financialComplianceCases)
        .where(and(eq(financialComplianceCases.caseId, caseId), NOT_HELD))
        .for('update');
      if (live.length === 0) return false; // held, or already swept
      await tx.delete(complianceCaseAudits).where(eq(complianceCaseAudits.caseId, caseId));
      await tx.delete(financialComplianceCases).where(eq(financialComplianceCases.caseId, caseId));
      return true;
    });
  }

  async anonymize(caseId: string, updatedAt: string): Promise<boolean> {
    const rows = await this.#db
      .update(financialComplianceCases)
      .set({
        userIdOrRoomId: null,
        partnerCaseRef: null,
        resolution: sql`CASE WHEN ${financialComplianceCases.resolution} IS NULL THEN NULL
          ELSE jsonb_set(${financialComplianceCases.resolution}, '{notes}', '"[anonymized]"') END`,
        // Marks the retention action DONE, so `listExpired` stops returning a
        // row whose deletion date is permanently in the past (it would
        // otherwise be re-anonymized and re-audited every sweep round).
        retentionPolicy: sql`jsonb_set(${financialComplianceCases.retentionPolicy}, '{anonymized_at}', ${JSON.stringify(updatedAt)}::jsonb)`,
        updatedAt: new Date(updatedAt),
      })
      .where(and(eq(financialComplianceCases.caseId, caseId), NOT_HELD))
      .returning({ caseId: financialComplianceCases.caseId });
    return rows.length > 0;
  }

  async listDeferredErasures(limit: number): Promise<ComplianceCaseRecord[]> {
    const rows = await this.#db
      .select()
      .from(financialComplianceCases)
      .where(
        and(
          sql`(${financialComplianceCases.retentionPolicy}->>'erasure_pending')::boolean = true`,
          NOT_HELD,
          sql`${financialComplianceCases.userIdOrRoomId} IS NOT NULL`,
        ),
      )
      .limit(limit);
    return rows.map(toCaseRecord);
  }

  async completeDeferredErasure(caseId: string, updatedAt: string): Promise<boolean> {
    // `NOT_HELD` in the WHERE: a fresh obligation can land between the sweep
    // choosing this case and this write, and it must win.
    const rows = await this.#db
      .update(financialComplianceCases)
      .set({
        userIdOrRoomId: null,
        retentionPolicy: sql`jsonb_set(${financialComplianceCases.retentionPolicy}, '{erasure_pending}', 'false'::jsonb)`,
        updatedAt: new Date(updatedAt),
      })
      .where(and(eq(financialComplianceCases.caseId, caseId), NOT_HELD))
      .returning({ caseId: financialComplianceCases.caseId });
    return rows.length > 0;
  }

  async applyLegalHold(input: {
    caseId: string;
    holdRef: string;
    hold: boolean;
    updatedAt: string;
  }): Promise<ComplianceCaseRecord | null> {
    // The read-modify-write runs in a transaction OF ITS OWN, so the row lock
    // below is held across both statements no matter who called us.
    //
    // It used to rely on `#db` already BEING the caller's transaction — true of
    // every production hold write, and false for anyone calling the store
    // directly.  On the pool a `SELECT … FOR UPDATE` releases the moment its
    // implicit single-statement transaction ends, so two concurrent holders
    // both read the pre-image and the second clobbers the first's ref: the
    // exact loss this lock exists to prevent, reintroduced by an assumption the
    // type could not enforce.  (CI's gated Postgres run caught it — the race is
    // timing-dependent and had passed locally.)
    //
    // Nested inside an existing unit this is a SAVEPOINT, so the outer
    // transaction's atomicity is unchanged and its locks still run to ITS
    // commit.
    return await this.#db.transaction(async (tx) => {
      const locked = await tx
        .select({ retentionPolicy: financialComplianceCases.retentionPolicy })
        .from(financialComplianceCases)
        .where(eq(financialComplianceCases.caseId, input.caseId))
        .for('update');
      const current = locked[0]?.retentionPolicy as CaseRetentionPolicy | undefined;
      if (current === undefined) return null;
      const rows = await tx
        .update(financialComplianceCases)
        .set({
          retentionPolicy: nextHoldPolicy(current, input.hold, input.holdRef),
          updatedAt: new Date(input.updatedAt),
        })
        .where(eq(financialComplianceCases.caseId, input.caseId))
        .returning();
      return rows[0] ? toCaseRecord(rows[0]) : null;
    });
  }

  async scrubUserSubject(userId: string): Promise<{ scrubbed: string[]; heldBack: string[] }> {
    // THREE statements — select the candidates, scrub the eligible, mark the
    // held-back with their deferred-erasure debt — and they are one act: a
    // crash between the scrub and the marking would drop the debt for a case
    // whose erasure was deferred, and nothing would ever come back for it (the
    // account is tombstoned by then).  Its own transaction, per the `DbOrTx`
    // rule above.
    return await this.#db.transaction(async (tx) => this.#scrubUserSubjectInTx(tx, userId));
  }

  async #scrubUserSubjectInTx(
    tx: Tx,
    userId: string,
  ): Promise<{ scrubbed: string[]; heldBack: string[] }> {
    const candidates = await tx
      .select({
        caseId: financialComplianceCases.caseId,
        retentionPolicy: financialComplianceCases.retentionPolicy,
      })
      .from(financialComplianceCases)
      .where(
        and(
          eq(financialComplianceCases.subjectKind, 'user'),
          eq(financialComplianceCases.userIdOrRoomId, userId),
        ),
      );
    const heldBack: string[] = [];
    const eligible: string[] = [];
    for (const row of candidates) {
      const policy = row.retentionPolicy as CaseRetentionPolicy;
      if (policy.legal_hold) heldBack.push(row.caseId);
      else eligible.push(row.caseId);
    }
    // `NOT_HELD` again, IN the update: a SAR draft or lawful-access intake can
    // apply a hold between choosing these candidates and scrubbing them, and
    // the carve-out this read implements would then be defeated — the held
    // case would lose the very subject the obligation is about.  `returning`
    // tells us which rows actually moved, so a row that lost the race is
    // reported as held back rather than as scrubbed.
    const updated =
      eligible.length === 0
        ? []
        : await tx
            .update(financialComplianceCases)
            .set({ userIdOrRoomId: null })
            .where(and(inArray(financialComplianceCases.caseId, eligible), NOT_HELD))
            .returning({ caseId: financialComplianceCases.caseId });
    const scrubbed = updated.map((row) => row.caseId);
    const moved = new Set(scrubbed);
    for (const caseId of eligible) if (!moved.has(caseId)) heldBack.push(caseId);
    if (heldBack.length > 0) {
      // The erasure is DEFERRED, not dropped: the case carries the debt so the
      // retention sweep can discharge it once the hold lapses.  Nothing else
      // will — the account is tombstoned and no later WS-D sweep names this
      // user again.  `jsonb_set` writes the key in ONE statement, so it cannot
      // clobber a concurrent hold write the way a read-modify-write would.
      await tx
        .update(financialComplianceCases)
        .set({
          retentionPolicy: sql`jsonb_set(${financialComplianceCases.retentionPolicy}, '{erasure_pending}', 'true'::jsonb)`,
        })
        .where(inArray(financialComplianceCases.caseId, heldBack));
    }
    return { scrubbed, heldBack };
  }
}

// ---------------------------------------------------------------------------
// The per-case review chain (WS-N.2.1c).
// ---------------------------------------------------------------------------

type CaseAuditRowDb = typeof complianceCaseAudits.$inferSelect;

function toCaseAudit(row: CaseAuditRowDb): CaseAuditRecord {
  return {
    auditId: row.auditId,
    caseId: row.caseId,
    action: row.action,
    actorRef: row.actorRef,
    beforeState: row.beforeState,
    afterState: row.afterState,
    note: row.note,
    prevHash: row.prevHash,
    integrityHash: row.integrityHash,
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleCaseAuditStore implements CaseAuditStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async chainHead(caseId: string): Promise<CaseAuditRecord | null> {
    const rows = await this.#db
      .select()
      .from(complianceCaseAudits)
      .where(
        and(
          eq(complianceCaseAudits.caseId, caseId),
          sql`${complianceCaseAudits.integrityHash} NOT IN (
            SELECT cca."prev_hash" FROM "compliance"."compliance_case_audit" cca
            WHERE cca."case_id" = ${caseId} AND cca."prev_hash" IS NOT NULL
          )`,
        ),
      )
      .limit(1);
    return rows[0] ? toCaseAudit(rows[0]) : null;
  }

  async appendChained(entry: CaseAuditRecord): Promise<CaseAuditRecord | null> {
    try {
      const rows = await this.#db
        .insert(complianceCaseAudits)
        .values({
          auditId: entry.auditId,
          caseId: entry.caseId,
          action: entry.action,
          actorRef: entry.actorRef,
          beforeState: entry.beforeState,
          afterState: entry.afterState,
          note: entry.note,
          prevHash: entry.prevHash,
          integrityHash: entry.integrityHash,
          createdAt: new Date(entry.createdAt),
        })
        .returning();
      const row = rows[0];
      return row ? toCaseAudit(row) : null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async listChained(caseId: string): Promise<CaseAuditRecord[]> {
    const rows = await this.#db
      .select()
      .from(complianceCaseAudits)
      .where(eq(complianceCaseAudits.caseId, caseId))
      .orderBy(asc(complianceCaseAudits.createdAt));
    return rows.map(toCaseAudit);
  }

  async deleteByCase(caseId: string): Promise<number> {
    // The sanctioned retention path: same-transaction GUC + delete.
    let removed = 0;
    await this.#db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('licio.compliance_retention', 'on', true)`);
      const rows = await tx
        .delete(complianceCaseAudits)
        .where(eq(complianceCaseAudits.caseId, caseId))
        .returning({ auditId: complianceCaseAudits.auditId });
      removed = rows.length;
    });
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Region declarations (WS-N.1.1f).
// ---------------------------------------------------------------------------

type DeclarationRowDb = typeof regionDeclarations.$inferSelect;

function toDeclaration(row: DeclarationRowDb): RegionDeclarationRecord {
  return {
    userId: row.userId,
    declaredRegion: row.declaredRegion,
    status: row.status,
    verificationLevel: row.verificationLevel,
    evidenceRef: row.evidenceRef,
    verifiedAt: isoOrNull(row.verifiedAt),
    verifiedBy: row.verifiedBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleRegionDeclarationStore implements RegionDeclarationStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async get(userId: string): Promise<RegionDeclarationRecord | null> {
    const rows = await this.#db
      .select()
      .from(regionDeclarations)
      .where(eq(regionDeclarations.userId, userId))
      .limit(1);
    return rows[0] ? toDeclaration(rows[0]) : null;
  }

  async upsert(
    record: RegionDeclarationRecord,
    expected?: DeclarationPremises,
  ): Promise<RegionDeclarationRecord | null> {
    const values = {
      userId: record.userId,
      declaredRegion: record.declaredRegion,
      status: record.status,
      verificationLevel: record.verificationLevel,
      evidenceRef: record.evidenceRef,
      verifiedAt: record.verifiedAt === null ? null : new Date(record.verifiedAt),
      verifiedBy: record.verifiedBy,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    };
    const set = {
      declaredRegion: values.declaredRegion,
      status: values.status,
      verificationLevel: values.verificationLevel,
      evidenceRef: values.evidenceRef,
      verifiedAt: values.verifiedAt,
      verifiedBy: values.verifiedBy,
      updatedAt: values.updatedAt,
    };
    // The CAS: a member who changed their declaration since the caller read it
    // makes this match zero rows rather than have their change overwritten by a
    // decision about the old one.  The region and status are compared too — two
    // changes inside one millisecond share a timestamp.
    //
    // With `expected`, the CAS requires an EXISTING row — an UPDATE, NEVER an
    // upsert.  If the declaration was deleted between the caller's read and here
    // (the deletion purge removes declarations before it tombstones the user),
    // an `ON CONFLICT DO UPDATE` finds no conflict and INSERTs a fresh row,
    // recreating region data for a deleting/deleted account and making a stale
    // reviewer decision live.  `UPDATE … WHERE (premises)` matches zero rows
    // there and returns null, exactly as the in-memory store does.
    // Each branch is a SINGLE atomic statement (the insert-or-CAS one way, the
    // conditional UPDATE the other) — `this.#db` sits inside the parens so the
    // read-modify-write atomicity scan does not read the two mutually exclusive
    // writes as a sequence.
    const rows = await (expected === undefined
      ? this.#db
          .insert(regionDeclarations)
          .values(values)
          .onConflictDoUpdate({ target: regionDeclarations.userId, set })
          .returning()
      : this.#db
          .update(regionDeclarations)
          .set(set)
          .where(
            and(
              eq(regionDeclarations.userId, record.userId),
              eq(regionDeclarations.declaredRegion, expected.declaredRegion),
              eq(regionDeclarations.status, expected.status),
              eq(regionDeclarations.updatedAt, new Date(expected.updatedAt)),
            ),
          )
          .returning());
    const row = rows[0];
    if (row === undefined) return null; // CAS lost, row missing, or nothing written
    return toDeclaration(row);
  }

  async delete(userId: string): Promise<boolean> {
    const rows = await this.#db
      .delete(regionDeclarations)
      .where(eq(regionDeclarations.userId, userId))
      .returning({ userId: regionDeclarations.userId });
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// KYC verification standing (WS-N.1.1f / bot-prevention layer 3).
// ---------------------------------------------------------------------------

type KycRowDb = typeof kycVerifications.$inferSelect;

function toKyc(row: KycRowDb): KycVerificationRecord {
  return {
    userId: row.userId,
    status: row.status,
    evidenceRef: row.evidenceRef,
    verifiedAt: isoOrNull(row.verifiedAt),
    verifiedBy: row.verifiedBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleKycVerificationStore implements KycVerificationStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async get(userId: string): Promise<KycVerificationRecord | null> {
    const rows = await this.#db
      .select()
      .from(kycVerifications)
      .where(eq(kycVerifications.userId, userId))
      .limit(1);
    return rows[0] ? toKyc(rows[0]) : null;
  }

  async upsert(
    record: KycVerificationRecord,
    expected?: KycPremises,
  ): Promise<KycVerificationRecord | null> {
    const values = {
      userId: record.userId,
      status: record.status,
      evidenceRef: record.evidenceRef,
      verifiedAt: record.verifiedAt === null ? null : new Date(record.verifiedAt),
      verifiedBy: record.verifiedBy,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    };
    const set = {
      status: values.status,
      evidenceRef: values.evidenceRef,
      verifiedAt: values.verifiedAt,
      verifiedBy: values.verifiedBy,
      updatedAt: values.updatedAt,
    };
    // CAS discipline in BOTH directions. With `expected` this is an UPDATE,
    // never an upsert — a record deleted under review (the deletion purge) must
    // not be resurrected by a stale reviewer decision. WITHOUT `expected` this
    // is a CREATE, and it is conflict-only (`onConflictDoNothing`): if a row
    // already exists it inserts nothing and returns null, so two reviewers who
    // both read an absent standing and submit the only allowed initial decision
    // (`verify`) concurrently cannot silently overwrite each other — the loser
    // gets `null` and the route answers `kyc_changed` (409), same as a CAS miss.
    const rows = await (expected === undefined
      ? this.#db.insert(kycVerifications).values(values).onConflictDoNothing().returning()
      : this.#db
          .update(kycVerifications)
          .set(set)
          .where(
            and(
              eq(kycVerifications.userId, record.userId),
              eq(kycVerifications.status, expected.status),
              eq(kycVerifications.updatedAt, new Date(expected.updatedAt)),
            ),
          )
          .returning());
    const row = rows[0];
    if (row === undefined) return null;
    return toKyc(row);
  }

  async delete(userId: string): Promise<boolean> {
    const rows = await this.#db
      .delete(kycVerifications)
      .where(eq(kycVerifications.userId, userId))
      .returning({ userId: kycVerifications.userId });
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Disclosures + acknowledgments (WS-N.1.2d).
// ---------------------------------------------------------------------------

type DisclosureRowDb = typeof disclosureVersions.$inferSelect;

function toDisclosure(row: DisclosureRowDb): DisclosureVersionRecord {
  return {
    id: row.id,
    disclosureId: row.disclosureId,
    region: row.region,
    version: row.version,
    locale: row.locale,
    title: row.title,
    contentMd: row.contentMd,
    requiresAcknowledgment: row.requiresAcknowledgment,
    publishedByRef: row.publishedByRef,
    publishedAt: iso(row.publishedAt),
  };
}

export class DrizzleDisclosureStore implements DisclosureStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async publish(record: DisclosureVersionRecord): Promise<DisclosureVersionRecord> {
    const rows = await this.#db
      .insert(disclosureVersions)
      .values({
        id: record.id,
        disclosureId: record.disclosureId,
        region: record.region,
        version: record.version,
        locale: record.locale,
        title: record.title,
        contentMd: record.contentMd,
        requiresAcknowledgment: record.requiresAcknowledgment,
        publishedByRef: record.publishedByRef,
        publishedAt: new Date(record.publishedAt),
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('disclosure publish returned no row');
    return toDisclosure(row);
  }

  async listForRegion(region: string): Promise<DisclosureVersionRecord[]> {
    const rows = await this.#db
      .select()
      .from(disclosureVersions)
      .where(eq(disclosureVersions.region, region))
      .orderBy(desc(disclosureVersions.version));
    return rows.map(toDisclosure);
  }

  async get(
    disclosureId: string,
    region: string,
    version: number,
  ): Promise<DisclosureVersionRecord | null> {
    const rows = await this.#db
      .select()
      .from(disclosureVersions)
      .where(
        and(
          eq(disclosureVersions.disclosureId, disclosureId),
          eq(disclosureVersions.region, region),
          eq(disclosureVersions.version, version),
        ),
      )
      .limit(1);
    return rows[0] ? toDisclosure(rows[0]) : null;
  }

  async listForVersion(
    disclosureId: string,
    region: string,
    version: number,
  ): Promise<DisclosureVersionRecord[]> {
    const rows = await this.#db
      .select()
      .from(disclosureVersions)
      .where(
        and(
          eq(disclosureVersions.disclosureId, disclosureId),
          eq(disclosureVersions.region, region),
          eq(disclosureVersions.version, version),
        ),
      );
    return rows.map(toDisclosure);
  }
}

export class DrizzleDisclosureAckStore implements DisclosureAckStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async record(ack: DisclosureAckRecord): Promise<DisclosureAckRecord> {
    const toRecord = (row: typeof disclosureAcknowledgments.$inferSelect): DisclosureAckRecord => ({
      id: row.id,
      userId: row.userId,
      disclosureId: row.disclosureId,
      version: row.version,
      region: row.region,
      acknowledgedAt: iso(row.acknowledgedAt),
    });
    // Idempotent by CONFLICTING QUIETLY, never by catching the 23505 and
    // re-reading: inside a transaction that catch is unrecoverable — the
    // violation has already aborted the unit, so the recovery SELECT fails too
    // and the caller sees a store error where an existing row was the answer.
    // This store is built over `DbOrTx` and only today's call graph keeps it off
    // the transactional path; the shape must be safe on either.
    const inserted = await this.#db
      .insert(disclosureAcknowledgments)
      .values({
        id: ack.id,
        userId: ack.userId,
        disclosureId: ack.disclosureId,
        version: ack.version,
        region: ack.region,
        acknowledgedAt: new Date(ack.acknowledgedAt),
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (row !== undefined) return toRecord(row);
    // Lost the unique — the acknowledgment already stands.  (An anonymized ack
    // carries a null owner and cannot be found again; it is also never
    // re-recorded, since the user it belonged to is gone.)
    if (ack.userId === null) throw new Error('disclosure ack insert returned no row');
    const existing = await this.#db
      .select()
      .from(disclosureAcknowledgments)
      .where(
        and(
          eq(disclosureAcknowledgments.userId, ack.userId),
          eq(disclosureAcknowledgments.disclosureId, ack.disclosureId),
          eq(disclosureAcknowledgments.version, ack.version),
          eq(disclosureAcknowledgments.region, ack.region),
        ),
      )
      .limit(1);
    const found = existing[0];
    if (found === undefined) throw new Error('disclosure ack insert returned no row');
    return toRecord(found);
  }

  async has(
    userId: string,
    disclosureId: string,
    version: number,
    region: string,
  ): Promise<boolean> {
    const rows = await this.#db
      .select({ id: disclosureAcknowledgments.id })
      .from(disclosureAcknowledgments)
      .where(
        and(
          eq(disclosureAcknowledgments.userId, userId),
          eq(disclosureAcknowledgments.disclosureId, disclosureId),
          eq(disclosureAcknowledgments.version, version),
          eq(disclosureAcknowledgments.region, region),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listByUser(userId: string): Promise<DisclosureAckRecord[]> {
    const rows = await this.#db
      .select()
      .from(disclosureAcknowledgments)
      .where(eq(disclosureAcknowledgments.userId, userId));
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      disclosureId: row.disclosureId,
      version: row.version,
      region: row.region,
      acknowledgedAt: iso(row.acknowledgedAt),
    }));
  }

  async anonymizeUser(userId: string): Promise<number> {
    const rows = await this.#db
      .update(disclosureAcknowledgments)
      .set({ userId: null })
      .where(eq(disclosureAcknowledgments.userId, userId))
      .returning({ id: disclosureAcknowledgments.id });
    return rows.length;
  }
}

// ---------------------------------------------------------------------------
// Wallet-risk pins (WS-N.2.2e / WS-N.2.3b).
// ---------------------------------------------------------------------------

type PinRowDb = typeof walletRiskPins.$inferSelect;

function toPin(row: PinRowDb): WalletRiskPinRecord {
  return {
    id: row.id,
    walletAccountId: row.walletAccountId,
    reason: row.reason,
    pinnedByRef: row.pinnedByRef,
    createdAt: iso(row.createdAt),
    releasedAt: isoOrNull(row.releasedAt),
    releasedByRef: row.releasedByRef,
  };
}

export class DrizzleWalletRiskPinStore implements WalletRiskPinStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async activeForWallet(walletAccountId: string): Promise<WalletRiskPinRecord | null> {
    const rows = await this.#db
      .select()
      .from(walletRiskPins)
      .where(
        and(eq(walletRiskPins.walletAccountId, walletAccountId), isNull(walletRiskPins.releasedAt)),
      )
      .limit(1);
    return rows[0] ? toPin(rows[0]) : null;
  }

  async pin(record: WalletRiskPinRecord): Promise<WalletRiskPinRecord> {
    // ON CONFLICT DO NOTHING for the same reason as the case insert: pins now
    // run inside the unit of work (the sanctioned-link hook), where a raised
    // unique would abort the transaction before the active-pin read below.
    const rows = await this.#db
      .insert(walletRiskPins)
      .values({
        id: record.id,
        walletAccountId: record.walletAccountId,
        reason: record.reason,
        pinnedByRef: record.pinnedByRef,
        createdAt: new Date(record.createdAt),
        releasedAt: null,
        releasedByRef: null,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (row !== undefined) return toPin(row);
    // The active-pin partial unique makes pinning idempotent.
    const existing = await this.activeForWallet(record.walletAccountId);
    if (existing !== null) return existing;
    throw new Error('wallet pin insert returned no row');
  }

  async release(
    walletAccountId: string,
    releasedByRef: string,
    releasedAt: string,
  ): Promise<boolean> {
    const rows = await this.#db
      .update(walletRiskPins)
      .set({ releasedAt: new Date(releasedAt), releasedByRef })
      .where(
        and(eq(walletRiskPins.walletAccountId, walletAccountId), isNull(walletRiskPins.releasedAt)),
      )
      .returning({ id: walletRiskPins.id });
    return rows.length > 0;
  }

  async purgeForWallets(walletAccountIds: readonly string[]): Promise<number> {
    if (walletAccountIds.length === 0) return 0;
    const rows = await this.#db
      .delete(walletRiskPins)
      .where(inArray(walletRiskPins.walletAccountId, [...walletAccountIds]))
      .returning({ id: walletRiskPins.id });
    return rows.length;
  }
}

// ---------------------------------------------------------------------------
// SAR/STR records (WS-N.2.1e) — counsel-only surface.
// ---------------------------------------------------------------------------

type SarRowDb = typeof sarReports.$inferSelect;

function toSar(row: SarRowDb): SarRecord {
  return {
    sarId: row.sarId,
    caseId: row.caseId,
    jurisdiction: row.jurisdiction,
    status: row.status,
    narrative: row.narrative,
    filingRef: row.filingRef,
    filedAt: isoOrNull(row.filedAt),
    partnerFiled: row.partnerFiled,
    createdByRef: row.createdByRef,
    approvedByRef: row.approvedByRef,
    filedByRef: row.filedByRef,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleSarStore implements SarStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async insert(record: SarRecord): Promise<SarRecord> {
    const rows = await this.#db
      .insert(sarReports)
      .values({
        sarId: record.sarId,
        caseId: record.caseId,
        jurisdiction: record.jurisdiction,
        status: record.status,
        narrative: record.narrative,
        filingRef: record.filingRef,
        filedAt: record.filedAt === null ? null : new Date(record.filedAt),
        partnerFiled: record.partnerFiled,
        createdByRef: record.createdByRef,
        approvedByRef: record.approvedByRef,
        filedByRef: record.filedByRef,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('sar insert returned no row');
    return toSar(row);
  }

  async getById(sarId: string): Promise<SarRecord | null> {
    const rows = await this.#db
      .select()
      .from(sarReports)
      .where(eq(sarReports.sarId, sarId))
      .limit(1);
    return rows[0] ? toSar(rows[0]) : null;
  }

  async listByCase(caseId: string): Promise<SarRecord[]> {
    const rows = await this.#db.select().from(sarReports).where(eq(sarReports.caseId, caseId));
    return rows.map(toSar);
  }

  async list(limit: number): Promise<SarRecord[]> {
    const rows = await this.#db
      .select()
      .from(sarReports)
      .orderBy(desc(sarReports.createdAt))
      .limit(limit);
    return rows.map(toSar);
  }

  async update(
    sarId: string,
    patch: Partial<
      Pick<
        SarRecord,
        | 'status'
        | 'filingRef'
        | 'filedAt'
        | 'partnerFiled'
        | 'approvedByRef'
        | 'filedByRef'
        | 'narrative'
      >
    >,
    updatedAt: string,
    expectedStatus?: readonly SarStatus[],
  ): Promise<SarRecord | null> {
    const rows = await this.#db
      .update(sarReports)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.filingRef !== undefined ? { filingRef: patch.filingRef } : {}),
        ...(patch.filedAt !== undefined
          ? { filedAt: patch.filedAt === null ? null : new Date(patch.filedAt) }
          : {}),
        ...(patch.partnerFiled !== undefined ? { partnerFiled: patch.partnerFiled } : {}),
        ...(patch.approvedByRef !== undefined ? { approvedByRef: patch.approvedByRef } : {}),
        ...(patch.filedByRef !== undefined ? { filedByRef: patch.filedByRef } : {}),
        ...(patch.narrative !== undefined ? { narrative: patch.narrative } : {}),
        updatedAt: new Date(updatedAt),
      })
      .where(
        expectedStatus === undefined
          ? eq(sarReports.sarId, sarId)
          : and(
              eq(sarReports.sarId, sarId),
              // The CAS: a racing counsel session that already filed makes this
              // match zero rows rather than overwrite their filing record.
              inArray(sarReports.status, [...expectedStatus]),
            ),
      )
      .returning();
    return rows[0] ? toSar(rows[0]) : null;
  }
}

// ---------------------------------------------------------------------------
// Lawful-access requests (WS-N.2.3d).
// ---------------------------------------------------------------------------

type LawfulRowDb = typeof lawfulAccessRequests.$inferSelect;

function toLawful(row: LawfulRowDb): LawfulAccessRecord {
  return {
    requestId: row.requestId,
    agency: row.agency,
    jurisdiction: row.jurisdiction,
    legalBasis: row.legalBasis,
    scope: row.scope as LawfulAccessRecord['scope'],
    contact: row.contact,
    status: row.status,
    reviewNote: row.reviewNote,
    reviewedByRef: row.reviewedByRef,
    productionSummary: row.productionSummary,
    userNotifiedAt: isoOrNull(row.userNotifiedAt),
    caseId: row.caseId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleLawfulAccessStore implements LawfulAccessStore {
  readonly #db: DbOrTx;
  constructor(db: DbOrTx) {
    this.#db = db;
  }

  async insert(record: LawfulAccessRecord): Promise<LawfulAccessRecord> {
    const rows = await this.#db
      .insert(lawfulAccessRequests)
      .values({
        requestId: record.requestId,
        agency: record.agency,
        jurisdiction: record.jurisdiction,
        legalBasis: record.legalBasis,
        scope: record.scope,
        contact: record.contact,
        status: record.status,
        reviewNote: record.reviewNote,
        reviewedByRef: record.reviewedByRef,
        productionSummary: record.productionSummary,
        userNotifiedAt: record.userNotifiedAt === null ? null : new Date(record.userNotifiedAt),
        caseId: record.caseId,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('lawful-access insert returned no row');
    return toLawful(row);
  }

  async getById(requestId: string): Promise<LawfulAccessRecord | null> {
    const rows = await this.#db
      .select()
      .from(lawfulAccessRequests)
      .where(eq(lawfulAccessRequests.requestId, requestId))
      .limit(1);
    return rows[0] ? toLawful(rows[0]) : null;
  }

  async list(status: LawfulAccessStatus | null, limit: number): Promise<LawfulAccessRecord[]> {
    const rows = await this.#db
      .select()
      .from(lawfulAccessRequests)
      .where(status === null ? undefined : eq(lawfulAccessRequests.status, status))
      .orderBy(desc(lawfulAccessRequests.createdAt))
      .limit(limit);
    return rows.map(toLawful);
  }

  async unnotifiedCaseIdsForSubject(subjectRef: string): Promise<string[]> {
    const rows = await this.#db
      .select({ caseId: lawfulAccessRequests.caseId })
      .from(lawfulAccessRequests)
      .where(
        and(
          sql`${lawfulAccessRequests.scope}->>'subject_ref' = ${subjectRef}`,
          isNull(lawfulAccessRequests.userNotifiedAt),
          // Suppress only STILL-HIDDEN requests: a denied one (never notified,
          // so `userNotifiedAt` stays null) is released + closed, so keeping it
          // suppressed would hide the subject's own generic closed case forever.
          ne(lawfulAccessRequests.status, 'denied'),
        ),
      );
    return rows.flatMap((row) => (row.caseId === null ? [] : [row.caseId]));
  }

  async update(
    requestId: string,
    patch: Partial<
      Pick<
        LawfulAccessRecord,
        | 'status'
        | 'reviewNote'
        | 'reviewedByRef'
        | 'productionSummary'
        | 'userNotifiedAt'
        | 'caseId'
      >
    >,
    updatedAt: string,
    expectedStatus?: readonly LawfulAccessStatus[],
  ): Promise<LawfulAccessRecord | null> {
    const rows = await this.#db
      .update(lawfulAccessRequests)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.reviewNote !== undefined ? { reviewNote: patch.reviewNote } : {}),
        ...(patch.reviewedByRef !== undefined ? { reviewedByRef: patch.reviewedByRef } : {}),
        ...(patch.productionSummary !== undefined
          ? { productionSummary: patch.productionSummary }
          : {}),
        ...(patch.userNotifiedAt !== undefined
          ? {
              userNotifiedAt: patch.userNotifiedAt === null ? null : new Date(patch.userNotifiedAt),
            }
          : {}),
        ...(patch.caseId !== undefined ? { caseId: patch.caseId } : {}),
        updatedAt: new Date(updatedAt),
      })
      .where(
        expectedStatus === undefined
          ? eq(lawfulAccessRequests.requestId, requestId)
          : and(
              eq(lawfulAccessRequests.requestId, requestId),
              // The CAS: a racing reviewer that already moved the status makes
              // this match zero rows rather than overwrite their decision.
              inArray(lawfulAccessRequests.status, [...expectedStatus]),
            ),
      )
      .returning();
    return rows[0] ? toLawful(rows[0]) : null;
  }
}

/** Convenience factory: every Drizzle compliance store over one client. */
/**
 * The production `ComplianceTransactor`: ONE Postgres transaction over the
 * `compliance` schema, so a mutation and its hash-chain entry commit together
 * or not at all.  A chain fork raises inside the unit, which aborts the
 * transaction — `runChainedUnit` then replays the work against the new head
 * (a unique violation poisons a Postgres transaction, so the retry cannot
 * live inside one).
 */
export class DrizzleComplianceTransactor implements ComplianceTransactor {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async run<T>(work: (stores: ComplianceTxStores) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => work(complianceStoresOver(tx)));
  }
}

/** Every unit-of-work store bound to one handle (a db or a transaction). */
function complianceStoresOver(db: DbOrTx): ComplianceTxStores {
  return {
    cases: new DrizzleComplianceCaseStore(db),
    caseAudit: new DrizzleCaseAuditStore(db),
    policies: new DrizzleJurisdictionPolicyStore(db),
    policyAudit: new DrizzlePolicyAuditStore(db),
    sars: new DrizzleSarStore(db),
    lawfulAccess: new DrizzleLawfulAccessStore(db),
    pins: new DrizzleWalletRiskPinStore(db),
    declarations: new DrizzleRegionDeclarationStore(db),
    kyc: new DrizzleKycVerificationStore(db),
    disclosures: new DrizzleDisclosureStore(db),
    // The `compliance.*` runtime-config keys, so a change and the record of who
    // made it commit together (one `pwatt_config` table, one handle).
    config: new DrizzlePwattConfigStore(db),
    // The WS-D trail on the SAME handle: one action, both records.
    identityAudit: new DrizzleAuditStore(db),
  };
}

/**
 * The production compliance adapters — stores AND the transactor together, so
 * the boot's single `Object.assign` cannot wire Postgres stores while leaving
 * the in-memory (non-transactional) unit of work behind.
 */
export function createDrizzleComplianceStores(db: Db): ComplianceTxStores & {
  declarations: DrizzleRegionDeclarationStore;
  kyc: DrizzleKycVerificationStore;
  disclosures: DrizzleDisclosureStore;
  acks: DrizzleDisclosureAckStore;
  transactor: ComplianceTransactor;
} {
  return {
    ...complianceStoresOver(db),
    declarations: new DrizzleRegionDeclarationStore(db),
    kyc: new DrizzleKycVerificationStore(db),
    disclosures: new DrizzleDisclosureStore(db),
    acks: new DrizzleDisclosureAckStore(db),
    transactor: new DrizzleComplianceTransactor(db),
  };
}
