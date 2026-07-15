// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N compliance stores: the store interfaces plus the in-memory adapters
// used by tests/CI/dev (the established interface + in-memory pattern; the
// gated Postgres adapters with the same surface live in
// `drizzle-compliance-stores.ts`, the Redis adapters in
// `redis-compliance-stores.ts`).  Every async method is a Promise so the
// production drop-in is transparent.
//
// Privacy boundary (WS-N.2.2d): no record here carries an attention, reading,
// ranking, personalization, or social field — compliance state is
// transaction-derived + case-management data only, by construction.  Chained
// audit records store NON-REVERSIBLE actor refs (WS-N.1.1g): erasure never
// mutates a hashed column.
import type {
  CaseResolution,
  CaseRetentionPolicy,
  CaseReviewState,
  CaseRiskLevel,
  CaseSubjectKind,
  CaseTriggerType,
  DeclarationStatus,
  DeclarationVerificationLevel,
  LawfulAccessBasis,
  LawfulAccessStatus,
  SarStatus,
} from '@licio/shared';

type Clock = () => number;

// ---------------------------------------------------------------------------
// Records.
// ---------------------------------------------------------------------------

/** A stored policy row: the RAW document plus the columns the engine keys on.
 *  `document` stays `unknown` on the read path — the engine validates through
 *  `validatePolicy` and treats a nonconforming row as ABSENT (fail-closed). */
export interface JurisdictionPolicyRow {
  policyId: string;
  countryOrRegion: string;
  effectiveAt: string;
  document: unknown;
  createdAt: string;
}

export interface PolicyAuditRecord {
  changeId: string;
  policyId: string;
  countryOrRegion: string;
  changeType: 'create' | 'update' | 'deactivate';
  changedByRef: string;
  previousValue: unknown | null;
  newValue: unknown;
  reason: string;
  approvalRef: string | null;
  prevHash: string | null;
  integrityHash: string;
  createdAt: string;
}

export interface ComplianceCaseRecord {
  caseId: string;
  /** Polymorphic SOFT subject ref; null after a right-to-erasure scrub. */
  userIdOrRoomId: string | null;
  subjectKind: CaseSubjectKind;
  triggerType: CaseTriggerType;
  riskLevel: CaseRiskLevel;
  partnerCaseRef: string | null;
  reviewState: CaseReviewState;
  assignedTo: string | null;
  resolution: CaseResolution | null;
  retentionPolicy: CaseRetentionPolicy;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseAuditRecord {
  auditId: string;
  caseId: string;
  action: string;
  actorRef: string;
  beforeState: string | null;
  afterState: string | null;
  note: string | null;
  prevHash: string | null;
  integrityHash: string;
  createdAt: string;
}

export interface RegionDeclarationRecord {
  userId: string;
  declaredRegion: string;
  status: DeclarationStatus;
  verificationLevel: DeclarationVerificationLevel;
  evidenceRef: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DisclosureVersionRecord {
  id: string;
  disclosureId: string;
  region: string;
  version: number;
  locale: string;
  title: string;
  contentMd: string;
  requiresAcknowledgment: boolean;
  publishedAt: string;
}

export interface DisclosureAckRecord {
  id: string;
  userId: string | null;
  disclosureId: string;
  version: number;
  region: string;
  acknowledgedAt: string;
}

export interface WalletRiskPinRecord {
  id: string;
  walletAccountId: string;
  reason: string;
  pinnedByRef: string;
  createdAt: string;
  releasedAt: string | null;
  releasedByRef: string | null;
}

export interface SarRecord {
  sarId: string;
  caseId: string;
  jurisdiction: string;
  status: SarStatus;
  narrative: string;
  filingRef: string | null;
  filedAt: string | null;
  partnerFiled: boolean;
  createdByRef: string;
  approvedByRef: string | null;
  filedByRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LawfulAccessRecord {
  requestId: string;
  agency: string;
  jurisdiction: string;
  legalBasis: LawfulAccessBasis;
  scope: {
    subject_kind: 'user' | 'room' | 'transaction';
    subject_ref: string;
    time_range_start: string | null;
    time_range_end: string | null;
  };
  contact: string;
  status: LawfulAccessStatus;
  reviewNote: string | null;
  reviewedByRef: string | null;
  productionSummary: string | null;
  userNotifiedAt: string | null;
  caseId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Store interfaces.
// ---------------------------------------------------------------------------

export interface JurisdictionPolicyStore {
  insert(row: JurisdictionPolicyRow): Promise<JurisdictionPolicyRow>;
  /** The LATEST row with effective_at <= nowIso, or null.  RAW — the engine
   *  validates and treats a nonconforming latest row as region-missing
   *  (fail-closed: never a silent fallback to an older, possibly more
   *  permissive version). */
  activeForRegion(region: string, nowIso: string): Promise<JurisdictionPolicyRow | null>;
  /** True when the region has rows but none effective yet (future-dated). */
  hasOnlyFutureRows(region: string, nowIso: string): Promise<boolean>;
  listByRegion(region: string): Promise<JurisdictionPolicyRow[]>;
  listAll(): Promise<JurisdictionPolicyRow[]>;
  // No `delete`: a policy is superseded by a NEW version (which the chain
  // records), never removed.  The one caller that ever needed removal was the
  // compensator for an unauditable write — the unit of work made both the
  // compensator and the affordance unnecessary, and an unused delete path on
  // regulatory rows is a liability, not a convenience.
}

export interface PolicyAuditStore {
  chainHead(): Promise<PolicyAuditRecord | null>;
  /** Null ⇔ the parent slot was taken by a concurrent writer (fork-proof). */
  appendChained(entry: PolicyAuditRecord): Promise<PolicyAuditRecord | null>;
  listChained(): Promise<PolicyAuditRecord[]>;
}

export interface ComplianceCaseStore {
  /** Insert honoring `idempotencyKey`: a duplicate returns the EXISTING row. */
  insert(record: ComplianceCaseRecord): Promise<ComplianceCaseRecord>;
  getById(caseId: string): Promise<ComplianceCaseRecord | null>;
  findByIdempotencyKey(key: string): Promise<ComplianceCaseRecord | null>;
  listByStates(states: readonly CaseReviewState[], limit: number): Promise<ComplianceCaseRecord[]>;
  /** `offset` pages the DSAR export to completeness — an archive that silently
   *  stops at one page is not the user's full compliance footprint. */
  listBySubject(
    subjectRef: string,
    limit: number,
    offset?: number,
  ): Promise<ComplianceCaseRecord[]>;
  /** CAS on review_state; null ⇔ the state moved concurrently. */
  transition(
    caseId: string,
    fromState: CaseReviewState,
    patch: Partial<
      Pick<
        ComplianceCaseRecord,
        'reviewState' | 'assignedTo' | 'resolution' | 'retentionPolicy' | 'partnerCaseRef'
      >
    >,
    updatedAt: string,
  ): Promise<ComplianceCaseRecord | null>;
  /** Non-state patch (retention/legal-hold updates); null ⇔ unknown case. */
  update(
    caseId: string,
    patch: Partial<Pick<ComplianceCaseRecord, 'retentionPolicy' | 'partnerCaseRef'>>,
    updatedAt: string,
  ): Promise<ComplianceCaseRecord | null>;
  /** Cases past their deletion date and NOT under legal hold. */
  listExpired(nowIso: string, limit: number): Promise<ComplianceCaseRecord[]>;
  /** Open (non-resolved) cases at ANY of the given risk levels for a subject.
   *  The caller names the levels it means — the WS-N.1.1c `compliance_hold`
   *  asks for high+critical, the wallet-risk assessment asks for critical
   *  alone.  A COUNT, not a page: deriving either answer from a capped list
   *  would silently miss an older case beyond the page and downgrade the
   *  verdict. */
  countOpenByRisk(subjectRef: string, risks: readonly CaseRiskLevel[]): Promise<number>;
  /** The sanctioned retention delete: audit rows first, then the case (the
   *  Drizzle adapter runs both inside the `licio.compliance_retention` GUC
   *  transaction).  Throws if a SAR still references the case. */
  deleteCascade(caseId: string): Promise<void>;
  /** Anonymize the retained row in place (subject/partner/resolution notes). */
  anonymize(caseId: string, updatedAt: string): Promise<void>;
  /** Right-to-erasure scrub for a user subject: NULL the subject ref on every
   *  case NOT under legal hold; returns the scrubbed ids and the ids skipped
   *  because a hold applies (the audited carve-out, WS-N.2.1a). */
  scrubUserSubject(userId: string): Promise<{ scrubbed: string[]; heldBack: string[] }>;
}

export interface CaseAuditStore {
  chainHead(caseId: string): Promise<CaseAuditRecord | null>;
  appendChained(entry: CaseAuditRecord): Promise<CaseAuditRecord | null>;
  listChained(caseId: string): Promise<CaseAuditRecord[]>;
  /** Sanctioned retention delete for one case's trail (GUC-gated in Drizzle). */
  deleteByCase(caseId: string): Promise<number>;
}

export interface RegionDeclarationStore {
  get(userId: string): Promise<RegionDeclarationRecord | null>;
  upsert(record: RegionDeclarationRecord): Promise<RegionDeclarationRecord>;
  delete(userId: string): Promise<boolean>;
}

export interface DisclosureStore {
  /** Publish-immutable: an existing (id, region, version, locale) row throws. */
  publish(record: DisclosureVersionRecord): Promise<DisclosureVersionRecord>;
  listForRegion(region: string): Promise<DisclosureVersionRecord[]>;
  get(
    disclosureId: string,
    region: string,
    version: number,
  ): Promise<DisclosureVersionRecord | null>;
  /** EVERY published locale of one version.  A policy ref names the locales it
   *  must cover, and the DB keys versions by (id, region, version, locale), so
   *  a single-row read cannot tell whether the region's legal coverage is
   *  complete or which of several localizations the caller got. */
  listForVersion(
    disclosureId: string,
    region: string,
    version: number,
  ): Promise<DisclosureVersionRecord[]>;
}

export interface DisclosureAckStore {
  /** Idempotent: an existing (user, disclosure, version, region) ack is returned. */
  record(ack: DisclosureAckRecord): Promise<DisclosureAckRecord>;
  /** REGION-scoped: the same (disclosure, version) is different counsel-
   *  authored text per region, so an ack in one region is not evidence for
   *  another (WS-N.1.2d — otherwise changing regions would skip the gate). */
  has(userId: string, disclosureId: string, version: number, region: string): Promise<boolean>;
  listByUser(userId: string): Promise<DisclosureAckRecord[]>;
  /** Right-to-erasure: NULL the user ref (consent evidence stays, anonymized). */
  anonymizeUser(userId: string): Promise<number>;
}

export interface WalletRiskPinStore {
  activeForWallet(walletAccountId: string): Promise<WalletRiskPinRecord | null>;
  /** Idempotent: an active pin for the wallet is returned unchanged. */
  pin(record: WalletRiskPinRecord): Promise<WalletRiskPinRecord>;
  release(walletAccountId: string, releasedByRef: string, releasedAt: string): Promise<boolean>;
  /** Purge pins for the given wallets (account-deletion sweep). */
  purgeForWallets(walletAccountIds: readonly string[]): Promise<number>;
}

export interface SarStore {
  insert(record: SarRecord): Promise<SarRecord>;
  getById(sarId: string): Promise<SarRecord | null>;
  listByCase(caseId: string): Promise<SarRecord[]>;
  list(limit: number): Promise<SarRecord[]>;
  update(
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
  ): Promise<SarRecord | null>;
}

export interface LawfulAccessStore {
  insert(record: LawfulAccessRecord): Promise<LawfulAccessRecord>;
  getById(requestId: string): Promise<LawfulAccessRecord | null>;
  list(status: LawfulAccessStatus | null, limit: number): Promise<LawfulAccessRecord[]>;
  /** `expectedStatus` makes the write a CAS: null ⇔ the status moved under us
   *  (two counsel reviewers racing an approve and a deny would otherwise both
   *  pass the read-side check and let the last writer win — leaving a request
   *  `approved` while the denial already released its hold). */
  update(
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
  ): Promise<LawfulAccessRecord | null>;
}

// ---------------------------------------------------------------------------
// The unit of work (WS-N.1.1g / 2.1c).
// ---------------------------------------------------------------------------

/** The stores a compliance unit of work may write.  All live in the ONE
 *  `compliance` schema, so a real database transaction spans them. */
export interface ComplianceTxStores {
  cases: ComplianceCaseStore;
  caseAudit: CaseAuditStore;
  policies: JurisdictionPolicyStore;
  policyAudit: PolicyAuditStore;
  sars: SarStore;
  lawfulAccess: LawfulAccessStore;
  pins: WalletRiskPinStore;
}

/**
 * Runs a unit of work in which EVERY write commits together or none does.
 *
 * This is the structural answer to the rule the module is built on: no
 * compliance change may outlive its hash-chain entry, and no chain entry may
 * describe a change that did not happen.  Hand-written compensators can state
 * that rule but never guarantee it — each one is a second failure point (a
 * rollback can itself fail), each one has to re-derive what "undo" means, and
 * one forgotten call site silently reintroduces the defect.  A transaction
 * makes the pairing unforgeable instead: the mutation and its entry are one
 * write, and a fork or a fault leaves nothing behind to repair.
 *
 * The chain's parent slot is arbitrated by a partial unique, so a concurrent
 * writer aborts the whole unit — `runChainedUnit` re-reads the head and
 * replays the work.  That is why the retry lives OUTSIDE: a unique violation
 * poisons a Postgres transaction, so retrying within one is impossible.
 */
export interface ComplianceTransactor {
  run<T>(work: (stores: ComplianceTxStores) => Promise<T>): Promise<T>;
}

/** Thrown inside a unit when the chain's parent slot was taken concurrently;
 *  aborts the transaction so `runChainedUnit` can replay against the new head. */
export class ChainContentionError extends Error {
  constructor(label: string) {
    super(`${label}: the audit chain's parent slot was taken concurrently`);
    this.name = 'ChainContentionError';
  }
}

/**
 * The in-memory adapters' ROLLBACK (the house rule: they emulate every DB
 * protection, and a transaction is one).  Returning an undo CLOSURE keeps each
 * store's snapshot private — no row shape escapes through the transactor.
 */
export interface InMemoryRollback {
  /** Capture the current rows; the returned closure puts them back. */
  beginRollback(): () => void;
}

/**
 * The in-memory `ComplianceTransactor`: snapshot → run → restore on ANY throw,
 * giving tests and dev the same all-or-nothing semantics Postgres gives
 * production.  Re-entrant runs JOIN the outer unit rather than nesting a
 * second snapshot, so a composite (a SAR draft applying a hold, say) commits
 * once — matching the single transaction the Drizzle adapter opens.
 */
export class InMemoryComplianceTransactor implements ComplianceTransactor {
  readonly #stores: ComplianceTxStores;
  readonly #rollbacks: readonly InMemoryRollback[];
  #depth = 0;

  constructor(stores: ComplianceTxStores, rollbacks: readonly InMemoryRollback[]) {
    this.#stores = stores;
    this.#rollbacks = rollbacks;
  }

  async run<T>(work: (stores: ComplianceTxStores) => Promise<T>): Promise<T> {
    if (this.#depth > 0) return work(this.#stores); // join the ambient unit
    const undo = this.#rollbacks.map((store) => store.beginRollback());
    this.#depth += 1;
    try {
      return await work(this.#stores);
    } catch (error) {
      for (const restore of undo) restore();
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }
}

/** Screening-verdict cache (WS-N.2.2a; Redis in production). */
export interface ScreeningCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

/**
 * Atomic sliding-window reserve (WS-N.2.2b).  `reserve` prunes entries older
 * than the window, then EITHER admits the check (recording it) or rejects —
 * one atomic decision (single-threaded here; a Lua script in Redis), exact
 * decimal-string volume math (BigInt — 18-decimal assets never overflow).
 */
export interface VelocityStore {
  reserve(input: {
    key: string;
    nowMs: number;
    windowMs: number;
    amountMinorUnits: string;
    maxCount: number;
    maxVolumeMinorUnits: string;
  }): Promise<'ok' | 'exceeded'>;
}

/** Cross-instance policy-cache invalidation (WS-N.1.1e; Redis pub/sub in
 *  production, an in-process loopback in dev/tests). */
export interface PolicyInvalidationBroadcaster {
  publish(region: string | null): Promise<void>;
  subscribe(handler: (region: string | null) => void): void;
}

// ---------------------------------------------------------------------------
// In-memory adapters.
// ---------------------------------------------------------------------------

export class InMemoryJurisdictionPolicyStore implements JurisdictionPolicyStore, InMemoryRollback {
  readonly #rows: JurisdictionPolicyRow[] = [];

  beginRollback(): () => void {
    const snapshot = this.#rows.map((row) => ({ ...row }));
    return () => {
      this.#rows.length = 0;
      this.#rows.push(...snapshot);
    };
  }

  async insert(row: JurisdictionPolicyRow): Promise<JurisdictionPolicyRow> {
    if (
      this.#rows.some(
        (r) => r.countryOrRegion === row.countryOrRegion && r.effectiveAt === row.effectiveAt,
      )
    ) {
      throw new Error('duplicate (country_or_region, effective_at)');
    }
    this.#rows.push({ ...row });
    return row;
  }

  async activeForRegion(region: string, nowIso: string): Promise<JurisdictionPolicyRow | null> {
    const effective = this.#rows
      .filter((r) => r.countryOrRegion === region && r.effectiveAt <= nowIso)
      .sort((a, b) => (a.effectiveAt < b.effectiveAt ? 1 : -1));
    return effective[0] ? { ...effective[0] } : null;
  }

  async hasOnlyFutureRows(region: string, nowIso: string): Promise<boolean> {
    const rows = this.#rows.filter((r) => r.countryOrRegion === region);
    return rows.length > 0 && rows.every((r) => r.effectiveAt > nowIso);
  }

  async listByRegion(region: string): Promise<JurisdictionPolicyRow[]> {
    return this.#rows
      .filter((r) => r.countryOrRegion === region)
      .sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : 1))
      .map((r) => ({ ...r }));
  }

  async listAll(): Promise<JurisdictionPolicyRow[]> {
    return this.#rows.map((r) => ({ ...r }));
  }
}

export class InMemoryPolicyAuditStore implements PolicyAuditStore, InMemoryRollback {
  readonly #rows: PolicyAuditRecord[] = [];

  beginRollback(): () => void {
    const snapshot = this.#rows.map((row) => ({ ...row }));
    return () => {
      this.#rows.length = 0;
      this.#rows.push(...snapshot);
    };
  }

  async chainHead(): Promise<PolicyAuditRecord | null> {
    const last = this.#rows[this.#rows.length - 1];
    return last ? { ...last } : null;
  }

  async appendChained(entry: PolicyAuditRecord): Promise<PolicyAuditRecord | null> {
    // Fork-proofing (mirrors the partial uniques): one child per parent, one genesis.
    const collision = this.#rows.some((r) => (r.prevHash ?? null) === (entry.prevHash ?? null));
    if (collision) return null;
    this.#rows.push({ ...entry });
    return entry;
  }

  async listChained(): Promise<PolicyAuditRecord[]> {
    return this.#rows.map((r) => ({ ...r }));
  }
}

export class InMemoryComplianceCaseStore implements ComplianceCaseStore, InMemoryRollback {
  readonly #rows = new Map<string, ComplianceCaseRecord>();

  beginRollback(): () => void {
    const snapshot = new Map([...this.#rows].map(([key, row]) => [key, { ...row }] as const));
    return () => {
      this.#rows.clear();
      for (const [key, row] of snapshot) this.#rows.set(key, row);
    };
  }

  /** Cross-store deletion guard (mirrors the SAR FK RESTRICT). */
  sarGuard: ((caseId: string) => Promise<boolean>) | null = null;
  /** Cascade hook (mirrors the Drizzle adapter's single GUC transaction:
   *  the trail and the case are removed together, or neither is). */
  auditCascade: ((caseId: string) => Promise<void>) | null = null;

  async insert(record: ComplianceCaseRecord): Promise<ComplianceCaseRecord> {
    if (record.idempotencyKey !== null) {
      const existing = await this.findByIdempotencyKey(record.idempotencyKey);
      if (existing !== null) return existing;
    }
    this.#rows.set(record.caseId, { ...record });
    return { ...record };
  }

  async getById(caseId: string): Promise<ComplianceCaseRecord | null> {
    const row = this.#rows.get(caseId);
    return row ? { ...row } : null;
  }

  async findByIdempotencyKey(key: string): Promise<ComplianceCaseRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.idempotencyKey === key) return { ...row };
    }
    return null;
  }

  async listByStates(
    states: readonly CaseReviewState[],
    limit: number,
  ): Promise<ComplianceCaseRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => states.includes(r.reviewState))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listBySubject(
    subjectRef: string,
    limit: number,
    offset = 0,
  ): Promise<ComplianceCaseRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.userIdOrRoomId === subjectRef)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(offset, offset + limit)
      .map((r) => ({ ...r }));
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
    const row = this.#rows.get(caseId);
    if (!row || row.reviewState !== fromState) return null;
    const next = { ...row, ...patch, updatedAt };
    this.#rows.set(caseId, next);
    return { ...next };
  }

  async update(
    caseId: string,
    patch: Partial<Pick<ComplianceCaseRecord, 'retentionPolicy' | 'partnerCaseRef'>>,
    updatedAt: string,
  ): Promise<ComplianceCaseRecord | null> {
    const row = this.#rows.get(caseId);
    if (!row) return null;
    const next = { ...row, ...patch, updatedAt };
    this.#rows.set(caseId, next);
    return { ...next };
  }

  async listExpired(nowIso: string, limit: number): Promise<ComplianceCaseRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          !r.retentionPolicy.legal_hold &&
          // An already-anonymized case has discharged its retention action:
          // its deletion date stays in the past forever, so without this it
          // would be re-selected and re-anonymized on every round.
          (r.retentionPolicy.anonymized_at ?? null) === null &&
          r.retentionPolicy.deletion_date <= nowIso,
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async countOpenByRisk(subjectRef: string, risks: readonly CaseRiskLevel[]): Promise<number> {
    return [...this.#rows.values()].filter(
      (r) =>
        r.userIdOrRoomId === subjectRef &&
        r.reviewState !== 'resolved' &&
        risks.includes(r.riskLevel),
    ).length;
  }

  async deleteCascade(caseId: string): Promise<void> {
    // The guard runs BEFORE anything is removed, so a SAR-referenced case
    // leaves both the trail and the case intact — the all-or-nothing the
    // Drizzle adapter gets from its transaction (the FK aborts it).
    if (this.sarGuard !== null && (await this.sarGuard(caseId))) {
      throw new Error('case is referenced by a SAR/STR record (legal hold)');
    }
    await this.auditCascade?.(caseId);
    this.#rows.delete(caseId);
  }

  async anonymize(caseId: string, updatedAt: string): Promise<void> {
    const row = this.#rows.get(caseId);
    if (!row) return;
    this.#rows.set(caseId, {
      ...row,
      userIdOrRoomId: null,
      partnerCaseRef: null,
      resolution: row.resolution === null ? null : { ...row.resolution, notes: '[anonymized]' },
      // Marks the retention action DONE: the deletion date stays in the past
      // forever, so without this the sweep would re-select and re-anonymize
      // this row on every round (mirrors the Drizzle adapter).
      retentionPolicy: { ...row.retentionPolicy, anonymized_at: updatedAt },
      updatedAt,
    });
  }

  async scrubUserSubject(userId: string): Promise<{ scrubbed: string[]; heldBack: string[] }> {
    const scrubbed: string[] = [];
    const heldBack: string[] = [];
    for (const row of this.#rows.values()) {
      if (row.subjectKind !== 'user' || row.userIdOrRoomId !== userId) continue;
      if (row.retentionPolicy.legal_hold) {
        heldBack.push(row.caseId);
        continue;
      }
      this.#rows.set(row.caseId, { ...row, userIdOrRoomId: null });
      scrubbed.push(row.caseId);
    }
    return { scrubbed, heldBack };
  }
}

export class InMemoryCaseAuditStore implements CaseAuditStore, InMemoryRollback {
  readonly #rows: CaseAuditRecord[] = [];

  beginRollback(): () => void {
    const snapshot = this.#rows.map((row) => ({ ...row }));
    return () => {
      this.#rows.length = 0;
      this.#rows.push(...snapshot);
    };
  }

  async chainHead(caseId: string): Promise<CaseAuditRecord | null> {
    for (let i = this.#rows.length - 1; i >= 0; i -= 1) {
      const row = this.#rows[i];
      if (row && row.caseId === caseId) return { ...row };
    }
    return null;
  }

  async appendChained(entry: CaseAuditRecord): Promise<CaseAuditRecord | null> {
    const collision = this.#rows.some(
      (r) => r.caseId === entry.caseId && (r.prevHash ?? null) === (entry.prevHash ?? null),
    );
    if (collision) return null;
    this.#rows.push({ ...entry });
    return entry;
  }

  async listChained(caseId: string): Promise<CaseAuditRecord[]> {
    return this.#rows.filter((r) => r.caseId === caseId).map((r) => ({ ...r }));
  }

  async deleteByCase(caseId: string): Promise<number> {
    let removed = 0;
    for (let i = this.#rows.length - 1; i >= 0; i -= 1) {
      if (this.#rows[i]?.caseId === caseId) {
        this.#rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

export class InMemoryRegionDeclarationStore implements RegionDeclarationStore {
  readonly #rows = new Map<string, RegionDeclarationRecord>();

  async get(userId: string): Promise<RegionDeclarationRecord | null> {
    const row = this.#rows.get(userId);
    return row ? { ...row } : null;
  }

  async upsert(record: RegionDeclarationRecord): Promise<RegionDeclarationRecord> {
    this.#rows.set(record.userId, { ...record });
    return { ...record };
  }

  async delete(userId: string): Promise<boolean> {
    return this.#rows.delete(userId);
  }
}

export class InMemoryDisclosureStore implements DisclosureStore {
  readonly #rows: DisclosureVersionRecord[] = [];

  async publish(record: DisclosureVersionRecord): Promise<DisclosureVersionRecord> {
    if (
      this.#rows.some(
        (r) =>
          r.disclosureId === record.disclosureId &&
          r.region === record.region &&
          r.version === record.version &&
          r.locale === record.locale,
      )
    ) {
      throw new Error('disclosure version already published (publish-immutable)');
    }
    this.#rows.push({ ...record });
    return { ...record };
  }

  async listForRegion(region: string): Promise<DisclosureVersionRecord[]> {
    return this.#rows
      .filter((r) => r.region === region)
      .sort((a, b) => (a.version < b.version ? 1 : -1))
      .map((r) => ({ ...r }));
  }

  async get(
    disclosureId: string,
    region: string,
    version: number,
  ): Promise<DisclosureVersionRecord | null> {
    const row = this.#rows.find(
      (r) => r.disclosureId === disclosureId && r.region === region && r.version === version,
    );
    return row ? { ...row } : null;
  }

  async listForVersion(
    disclosureId: string,
    region: string,
    version: number,
  ): Promise<DisclosureVersionRecord[]> {
    return this.#rows
      .filter(
        (r) => r.disclosureId === disclosureId && r.region === region && r.version === version,
      )
      .map((r) => ({ ...r }));
  }
}

export class InMemoryDisclosureAckStore implements DisclosureAckStore {
  readonly #rows: DisclosureAckRecord[] = [];

  async record(ack: DisclosureAckRecord): Promise<DisclosureAckRecord> {
    // Mirrors the `da_user_version_uq` partial unique — region included.
    const existing = this.#rows.find(
      (r) =>
        r.userId !== null &&
        r.userId === ack.userId &&
        r.disclosureId === ack.disclosureId &&
        r.version === ack.version &&
        r.region === ack.region,
    );
    if (existing) return { ...existing };
    this.#rows.push({ ...ack });
    return { ...ack };
  }

  async has(
    userId: string,
    disclosureId: string,
    version: number,
    region: string,
  ): Promise<boolean> {
    return this.#rows.some(
      (r) =>
        r.userId === userId &&
        r.disclosureId === disclosureId &&
        r.version === version &&
        r.region === region,
    );
  }

  async listByUser(userId: string): Promise<DisclosureAckRecord[]> {
    return this.#rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  async anonymizeUser(userId: string): Promise<number> {
    let scrubbed = 0;
    for (let i = 0; i < this.#rows.length; i += 1) {
      const row = this.#rows[i];
      if (row && row.userId === userId) {
        this.#rows[i] = { ...row, userId: null };
        scrubbed += 1;
      }
    }
    return scrubbed;
  }
}

export class InMemoryWalletRiskPinStore implements WalletRiskPinStore, InMemoryRollback {
  readonly #rows: WalletRiskPinRecord[] = [];

  beginRollback(): () => void {
    const snapshot = this.#rows.map((row) => ({ ...row }));
    return () => {
      this.#rows.length = 0;
      this.#rows.push(...snapshot);
    };
  }

  async activeForWallet(walletAccountId: string): Promise<WalletRiskPinRecord | null> {
    const row = this.#rows.find(
      (r) => r.walletAccountId === walletAccountId && r.releasedAt === null,
    );
    return row ? { ...row } : null;
  }

  async pin(record: WalletRiskPinRecord): Promise<WalletRiskPinRecord> {
    const active = await this.activeForWallet(record.walletAccountId);
    if (active !== null) return active;
    this.#rows.push({ ...record });
    return { ...record };
  }

  async release(
    walletAccountId: string,
    releasedByRef: string,
    releasedAt: string,
  ): Promise<boolean> {
    const index = this.#rows.findIndex(
      (r) => r.walletAccountId === walletAccountId && r.releasedAt === null,
    );
    if (index < 0) return false;
    const row = this.#rows[index];
    if (!row) return false;
    this.#rows[index] = { ...row, releasedAt, releasedByRef };
    return true;
  }

  async purgeForWallets(walletAccountIds: readonly string[]): Promise<number> {
    const ids = new Set(walletAccountIds);
    let removed = 0;
    for (let i = this.#rows.length - 1; i >= 0; i -= 1) {
      if (ids.has(this.#rows[i]?.walletAccountId ?? '')) {
        this.#rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

export class InMemorySarStore implements SarStore, InMemoryRollback {
  readonly #rows = new Map<string, SarRecord>();

  beginRollback(): () => void {
    const snapshot = new Map([...this.#rows].map(([key, row]) => [key, { ...row }] as const));
    return () => {
      this.#rows.clear();
      for (const [key, row] of snapshot) this.#rows.set(key, row);
    };
  }

  async insert(record: SarRecord): Promise<SarRecord> {
    this.#rows.set(record.sarId, { ...record });
    return { ...record };
  }

  async getById(sarId: string): Promise<SarRecord | null> {
    const row = this.#rows.get(sarId);
    return row ? { ...row } : null;
  }

  async listByCase(caseId: string): Promise<SarRecord[]> {
    return [...this.#rows.values()].filter((r) => r.caseId === caseId).map((r) => ({ ...r }));
  }

  async list(limit: number): Promise<SarRecord[]> {
    return [...this.#rows.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((r) => ({ ...r }));
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
  ): Promise<SarRecord | null> {
    const row = this.#rows.get(sarId);
    if (!row) return null;
    const next = { ...row, ...patch, updatedAt };
    this.#rows.set(sarId, next);
    return { ...next };
  }
}

export class InMemoryLawfulAccessStore implements LawfulAccessStore, InMemoryRollback {
  readonly #rows = new Map<string, LawfulAccessRecord>();

  beginRollback(): () => void {
    const snapshot = new Map([...this.#rows].map(([key, row]) => [key, { ...row }] as const));
    return () => {
      this.#rows.clear();
      for (const [key, row] of snapshot) this.#rows.set(key, row);
    };
  }

  async insert(record: LawfulAccessRecord): Promise<LawfulAccessRecord> {
    this.#rows.set(record.requestId, { ...record });
    return { ...record };
  }

  async getById(requestId: string): Promise<LawfulAccessRecord | null> {
    const row = this.#rows.get(requestId);
    return row ? { ...row } : null;
  }

  async list(status: LawfulAccessStatus | null, limit: number): Promise<LawfulAccessRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => status === null || r.status === status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((r) => ({ ...r }));
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
    const row = this.#rows.get(requestId);
    if (!row) return null;
    // The CAS the Drizzle adapter gets from its WHERE clause.
    if (expectedStatus !== undefined && !expectedStatus.includes(row.status)) return null;
    const next = { ...row, ...patch, updatedAt };
    this.#rows.set(requestId, next);
    return { ...next };
  }
}

export class InMemoryScreeningCacheStore implements ScreeningCacheStore {
  readonly #rows = new Map<string, { value: string; expiresAt: number }>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async get(key: string): Promise<string | null> {
    const row = this.#rows.get(key);
    if (!row) return null;
    if (row.expiresAt <= this.#now()) {
      this.#rows.delete(key);
      return null;
    }
    return row.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#rows.set(key, { value, expiresAt: this.#now() + ttlMs });
  }
}

/**
 * The in-memory sliding-window reserve.  Exact math: amounts sum as BigInt
 * (an 18-decimal asset can never overflow or round), and the prune → check →
 * record step is one synchronous block — atomic under Node's single thread,
 * mirroring the Redis Lua script's atomicity.
 */
export class InMemoryVelocityStore implements VelocityStore {
  readonly #windows = new Map<string, Array<{ ts: number; amount: bigint }>>();

  async reserve(input: {
    key: string;
    nowMs: number;
    windowMs: number;
    amountMinorUnits: string;
    maxCount: number;
    maxVolumeMinorUnits: string;
  }): Promise<'ok' | 'exceeded'> {
    if (!/^\d{1,78}$/.test(input.amountMinorUnits)) return 'exceeded';
    const amount = BigInt(input.amountMinorUnits);
    const maxVolume = BigInt(input.maxVolumeMinorUnits);
    const cutoff = input.nowMs - input.windowMs;
    const entries = (this.#windows.get(input.key) ?? []).filter((e) => e.ts > cutoff);
    const volume = entries.reduce((sum, e) => sum + e.amount, 0n);
    if (entries.length + 1 > input.maxCount || volume + amount > maxVolume) {
      this.#windows.set(input.key, entries); // keep the prune
      return 'exceeded';
    }
    entries.push({ ts: input.nowMs, amount });
    this.#windows.set(input.key, entries);
    return 'ok';
  }
}

/** In-process loopback broadcaster (single-instance dev/tests). */
export class InMemoryPolicyInvalidationBroadcaster implements PolicyInvalidationBroadcaster {
  readonly #handlers: Array<(region: string | null) => void> = [];

  async publish(region: string | null): Promise<void> {
    for (const handler of this.#handlers) handler(region);
  }

  subscribe(handler: (region: string | null) => void): void {
    this.#handlers.push(handler);
  }
}
