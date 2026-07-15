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
  lawfulAccessRequests,
  regionDeclarations,
  sarReports,
  walletRiskPins,
} from '@licio/db';
import type {
  CaseResolution,
  CaseRetentionPolicy,
  CaseReviewState,
  LawfulAccessStatus,
} from '@licio/shared';
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type {
  CaseAuditRecord,
  CaseAuditStore,
  ComplianceCaseRecord,
  ComplianceCaseStore,
  DisclosureAckRecord,
  DisclosureAckStore,
  DisclosureStore,
  DisclosureVersionRecord,
  JurisdictionPolicyRow,
  JurisdictionPolicyStore,
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

type Db = ReturnType<typeof createDbClient>;

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value === null ? null : iso(value));

/** True when the error (or its cause chain) is a Postgres unique violation. */
function isUniqueViolation(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    if ((cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause ?? null;
  }
  return false;
}

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
  readonly #db: Db;
  constructor(db: Db) {
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

  async delete(policyId: string): Promise<boolean> {
    const rows = await this.#db
      .delete(jurisdictionFeaturePolicies)
      .where(eq(jurisdictionFeaturePolicies.policyId, policyId))
      .returning({ policyId: jurisdictionFeaturePolicies.policyId });
    return rows.length > 0;
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
  readonly #db: Db;
  constructor(db: Db) {
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
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(record: ComplianceCaseRecord): Promise<ComplianceCaseRecord> {
    try {
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
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error('compliance case insert returned no row');
      return toCaseRecord(row);
    } catch (error) {
      // The idempotency unique arbitrates a concurrent duplicate: theirs wins.
      if (isUniqueViolation(error) && record.idempotencyKey !== null) {
        const existing = await this.findByIdempotencyKey(record.idempotencyKey);
        if (existing !== null) return existing;
      }
      throw error;
    }
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

  async listBySubject(subjectRef: string, limit: number): Promise<ComplianceCaseRecord[]> {
    const rows = await this.#db
      .select()
      .from(financialComplianceCases)
      .where(eq(financialComplianceCases.userIdOrRoomId, subjectRef))
      .orderBy(desc(financialComplianceCases.createdAt))
      .limit(limit);
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
          sql`(${financialComplianceCases.retentionPolicy}->>'legal_hold')::boolean = false`,
          sql`(${financialComplianceCases.retentionPolicy}->>'deletion_date') <= ${nowIso}`,
        ),
      )
      .limit(limit);
    return rows.map(toCaseRecord);
  }

  async countOpenHighRisk(subjectRef: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(financialComplianceCases)
      .where(
        and(
          eq(financialComplianceCases.userIdOrRoomId, subjectRef),
          sql`${financialComplianceCases.reviewState} <> 'resolved'`,
          inArray(financialComplianceCases.riskLevel, ['high', 'critical']),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async deleteCascade(caseId: string): Promise<void> {
    // ONE transaction under the sanctioned retention GUC: trail, then case.
    // A SAR reference makes the case DELETE itself fail (FK RESTRICT).
    await this.#db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('licio.compliance_retention', 'on', true)`);
      await tx.delete(complianceCaseAudits).where(eq(complianceCaseAudits.caseId, caseId));
      await tx.delete(financialComplianceCases).where(eq(financialComplianceCases.caseId, caseId));
    });
  }

  async anonymize(caseId: string, updatedAt: string): Promise<void> {
    await this.#db
      .update(financialComplianceCases)
      .set({
        userIdOrRoomId: null,
        partnerCaseRef: null,
        resolution: sql`CASE WHEN ${financialComplianceCases.resolution} IS NULL THEN NULL
          ELSE jsonb_set(${financialComplianceCases.resolution}, '{notes}', '"[anonymized]"') END`,
        updatedAt: new Date(updatedAt),
      })
      .where(eq(financialComplianceCases.caseId, caseId));
  }

  async scrubUserSubject(userId: string): Promise<{ scrubbed: string[]; heldBack: string[] }> {
    const candidates = await this.#db
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
    const scrubbed: string[] = [];
    const heldBack: string[] = [];
    for (const row of candidates) {
      const policy = row.retentionPolicy as CaseRetentionPolicy;
      if (policy.legal_hold) heldBack.push(row.caseId);
      else scrubbed.push(row.caseId);
    }
    if (scrubbed.length > 0) {
      await this.#db
        .update(financialComplianceCases)
        .set({ userIdOrRoomId: null })
        .where(inArray(financialComplianceCases.caseId, scrubbed));
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
  readonly #db: Db;
  constructor(db: Db) {
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
  readonly #db: Db;
  constructor(db: Db) {
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

  async upsert(record: RegionDeclarationRecord): Promise<RegionDeclarationRecord> {
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
    const rows = await this.#db
      .insert(regionDeclarations)
      .values(values)
      .onConflictDoUpdate({
        target: regionDeclarations.userId,
        set: {
          declaredRegion: values.declaredRegion,
          status: values.status,
          verificationLevel: values.verificationLevel,
          evidenceRef: values.evidenceRef,
          verifiedAt: values.verifiedAt,
          verifiedBy: values.verifiedBy,
          updatedAt: values.updatedAt,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('region declaration upsert returned no row');
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
    publishedAt: iso(row.publishedAt),
  };
}

export class DrizzleDisclosureStore implements DisclosureStore {
  readonly #db: Db;
  constructor(db: Db) {
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
}

export class DrizzleDisclosureAckStore implements DisclosureAckStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async record(ack: DisclosureAckRecord): Promise<DisclosureAckRecord> {
    try {
      const rows = await this.#db
        .insert(disclosureAcknowledgments)
        .values({
          id: ack.id,
          userId: ack.userId,
          disclosureId: ack.disclosureId,
          version: ack.version,
          region: ack.region,
          acknowledgedAt: new Date(ack.acknowledgedAt),
        })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error('disclosure ack insert returned no row');
      return {
        id: row.id,
        userId: row.userId,
        disclosureId: row.disclosureId,
        version: row.version,
        region: row.region,
        acknowledgedAt: iso(row.acknowledgedAt),
      };
    } catch (error) {
      // Idempotent: the (user, disclosure, version, region) unique returns the
      // existing row.
      if (isUniqueViolation(error) && ack.userId !== null) {
        const rows = await this.#db
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
        const row = rows[0];
        if (row !== undefined) {
          return {
            id: row.id,
            userId: row.userId,
            disclosureId: row.disclosureId,
            version: row.version,
            region: row.region,
            acknowledgedAt: iso(row.acknowledgedAt),
          };
        }
      }
      throw error;
    }
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
  readonly #db: Db;
  constructor(db: Db) {
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
    try {
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
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error('wallet pin insert returned no row');
      return toPin(row);
    } catch (error) {
      // The active-pin partial unique makes pinning idempotent.
      if (isUniqueViolation(error)) {
        const existing = await this.activeForWallet(record.walletAccountId);
        if (existing !== null) return existing;
      }
      throw error;
    }
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
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleSarStore implements SarStore {
  readonly #db: Db;
  constructor(db: Db) {
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
        'status' | 'filingRef' | 'filedAt' | 'partnerFiled' | 'approvedByRef' | 'narrative'
      >
    >,
    updatedAt: string,
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
        ...(patch.narrative !== undefined ? { narrative: patch.narrative } : {}),
        updatedAt: new Date(updatedAt),
      })
      .where(eq(sarReports.sarId, sarId))
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
  readonly #db: Db;
  constructor(db: Db) {
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
      .where(eq(lawfulAccessRequests.requestId, requestId))
      .returning();
    return rows[0] ? toLawful(rows[0]) : null;
  }
}

/** Convenience factory: every Drizzle compliance store over one client. */
export function createDrizzleComplianceStores(db: Db): {
  policies: DrizzleJurisdictionPolicyStore;
  policyAudit: DrizzlePolicyAuditStore;
  cases: DrizzleComplianceCaseStore;
  caseAudit: DrizzleCaseAuditStore;
  declarations: DrizzleRegionDeclarationStore;
  disclosures: DrizzleDisclosureStore;
  acks: DrizzleDisclosureAckStore;
  pins: DrizzleWalletRiskPinStore;
  sars: DrizzleSarStore;
  lawfulAccess: DrizzleLawfulAccessStore;
} {
  return {
    policies: new DrizzleJurisdictionPolicyStore(db),
    policyAudit: new DrizzlePolicyAuditStore(db),
    cases: new DrizzleComplianceCaseStore(db),
    caseAudit: new DrizzleCaseAuditStore(db),
    declarations: new DrizzleRegionDeclarationStore(db),
    disclosures: new DrizzleDisclosureStore(db),
    acks: new DrizzleDisclosureAckStore(db),
    pins: new DrizzleWalletRiskPinStore(db),
    sars: new DrizzleSarStore(db),
    lawfulAccess: new DrizzleLawfulAccessStore(db),
  };
}
