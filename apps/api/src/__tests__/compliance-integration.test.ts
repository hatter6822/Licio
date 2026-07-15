// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-infrastructure contract tests for the WS-N compliance adapters —
// the same interfaces the in-memory adapters satisfy, against the REAL
// migration chain (0088's partial uniques, append-only triggers, and the
// sanctioned `licio.compliance_retention` GUC) and a REAL Redis:
//
//   • Postgres: versioned policy activation (never a future row), the two
//     fork-proof hash chains (parent/genesis slot arbitration → null →
//     retry), trigger-level append-only enforcement, the GUC-gated retention
//     delete, the SAR FK RESTRICT on deleteCascade, the idempotency-key
//     unique, the CAS case transition, the right-to-erasure scrub with the
//     legal-hold carve-out, publish-immutable disclosures, NULLing-only ack
//     erasure, and the one-active-pin partial unique.
//   • Redis: the atomic Lua velocity reserve with EXACT decimal-string math
//     (a value only exact arithmetic can reject — floats would admit it),
//     cross-instance sharing, window pruning, the screening cache TTL, and
//     the zod-validated policy-invalidation pub/sub (malformed → null, the
//     fail-closed invalidate-everything).
//
// Run when DATABASE_URL / REDIS_URL are set (CI's service containers):
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
//   REDIS_URL=redis://localhost:6379 pnpm test
import { randomUUID } from 'node:crypto';
import {
  createDbClient,
  disclosureAcknowledgments,
  disclosureVersions,
  financialComplianceCases,
  jurisdictionFeaturePolicies,
  jurisdictionPolicyAudits,
  lawfulAccessRequests,
  migrationsFolder,
  sarReports,
  users,
} from '@licio/db';
import {
  DEFAULT_AGE_GATE_POLICY,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  validatePolicy,
} from '@licio/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendCaseAudit,
  appendPolicyAudit,
  computeCaseAuditHash,
  computePolicyAuditHash,
  verifyCaseAuditChain,
  verifyPolicyAuditChain,
} from '../compliance/audit.js';
import { createDrizzleComplianceStores } from '../compliance/drizzle-compliance-stores.js';
import {
  RedisPolicyInvalidationBroadcaster,
  RedisScreeningCacheStore,
  RedisVelocityStore,
} from '../compliance/redis-compliance-stores.js';
import type { ComplianceCaseRecord, JurisdictionPolicyRow } from '../compliance/stores.js';

const DB_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
type Db = ReturnType<typeof createDbClient>;

const NOW = () => new Date().toISOString();
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const hoursAhead = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

/** Assert a write is rejected AND the trigger's message appears somewhere in
 *  the error's cause chain (drizzle wraps the Postgres error as `cause`). */
async function expectTriggerRejection(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the write to be rejected').not.toBeNull();
  const messages: string[] = [];
  let cursor: unknown = caught;
  for (let depth = 0; depth < 5 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const message = (cursor as { message?: unknown }).message;
    if (typeof message === 'string') messages.push(message);
    cursor = (cursor as { cause?: unknown }).cause ?? null;
  }
  expect(messages.join('\n')).toMatch(pattern);
}

/** A schema-valid policy document for a synthetic region. */
function policyDocOf(region: string, effectiveAt: string, note: string): JurisdictionPolicyRow {
  const policyId = randomUUID();
  return {
    policyId,
    countryOrRegion: region,
    effectiveAt,
    document: {
      policy_id: policyId,
      country_or_region: region,
      feature_flags: {
        wallet_connection: 'testnet',
        testnet_transactions: 'testnet',
        production_payments: 'disabled',
        treasury_operations: 'disabled',
        governance: 'simulated',
      },
      asset_flags: { USDC: true },
      age_gate_policy: DEFAULT_AGE_GATE_POLICY,
      kyc_policy: {},
      disclosure_refs: [{ id: `risk-${note}`, version: 1, locales: ['en'] }],
      legal_approval_ref: null,
      effective_at: effectiveAt,
    },
    createdAt: NOW(),
  };
}

function caseOf(
  subject: string | null,
  overrides: Partial<ComplianceCaseRecord> = {},
): ComplianceCaseRecord {
  const at = NOW();
  return {
    caseId: randomUUID(),
    userIdOrRoomId: subject,
    subjectKind: 'user',
    triggerType: 'velocity',
    riskLevel: 'medium',
    partnerCaseRef: null,
    reviewState: 'open',
    assignedTo: null,
    resolution: null,
    retentionPolicy: {
      retention_period_days: 1825,
      deletion_date: hoursAhead(24),
      legal_hold: false,
    },
    idempotencyKey: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe.skipIf(!DB_URL)('WS-N compliance Drizzle adapters (live Postgres)', () => {
  let db: Db;
  let stores: ReturnType<typeof createDrizzleComplianceStores>;
  let userId: string;
  // Synthetic region ids so a shared dev database is never polluted across runs.
  const region = `ZZ-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const futureRegion = `${region}-F`;
  const caseIds: string[] = [];
  const policyAuditIds: string[] = [];
  const lawfulRequestIds: string[] = [];
  const uuid = () => randomUUID();
  const clock = () => Date.now();

  const track = (record: ComplianceCaseRecord): ComplianceCaseRecord => {
    caseIds.push(record.caseId);
    return record;
  };
  const trackRequest = (requestId: string): string => {
    lawfulRequestIds.push(requestId);
    return requestId;
  };

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    stores = createDrizzleComplianceStores(db);
    const inserted = await db
      .insert(users)
      .values({
        handle: `wsn_it_${randomUUID().slice(0, 8)}`,
        displayName: 'WS-N Integration',
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
      })
      .returning();
    userId = (inserted[0] as { userId: string }).userId;
  });

  /** Row-scoped delete from an append-only table (test cleanup only): the
   *  BEFORE trigger is disabled around the scoped delete so other rows in a
   *  shared dev database are never touched. */
  async function deleteAppendOnly(table: string, trigger: string, where: string): Promise<void> {
    await db.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER "${trigger}"`));
    try {
      await db.execute(sql.raw(`DELETE FROM ${table} WHERE ${where}`));
    } finally {
      await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER "${trigger}"`));
    }
  }

  afterAll(async () => {
    // FK-safe order: SARs and lawful-access rows before their cases; audit
    // trails via the sanctioned GUC path; append-only tables via the scoped
    // trigger-disable idiom; the synthetic region rows last.
    if (lawfulRequestIds.length > 0) {
      await db
        .delete(lawfulAccessRequests)
        .where(inArray(lawfulAccessRequests.requestId, lawfulRequestIds));
    }
    if (caseIds.length > 0) {
      await db.delete(sarReports).where(inArray(sarReports.caseId, caseIds));
      for (const caseId of caseIds) await stores.caseAudit.deleteByCase(caseId);
      await db
        .delete(financialComplianceCases)
        .where(inArray(financialComplianceCases.caseId, caseIds));
    }
    if (policyAuditIds.length > 0) {
      await deleteAppendOnly(
        '"compliance"."jurisdiction_policy_audit"',
        'jurisdiction_policy_audit_append_only',
        `change_id IN (${policyAuditIds.map((id) => `'${id}'`).join(', ')})`,
      );
    }
    await deleteAppendOnly(
      '"compliance"."disclosure_acknowledgment"',
      'disclosure_acknowledgment_append_only',
      `region LIKE '${region}%'`,
    );
    await deleteAppendOnly(
      '"compliance"."disclosure_version"',
      'disclosure_version_immutable',
      `region LIKE '${region}%'`,
    );
    await db
      .delete(jurisdictionFeaturePolicies)
      .where(inArray(jurisdictionFeaturePolicies.countryOrRegion, [region, futureRegion]));
    await db.delete(users).where(eq(users.userId, userId)); // cascades the declaration
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  it('activates the LATEST effective policy version and never a future row', async () => {
    await stores.policies.insert(policyDocOf(region, hoursAgo(48), 'v1'));
    const v2 = await stores.policies.insert(policyDocOf(region, hoursAgo(24), 'v2'));
    await stores.policies.insert(policyDocOf(region, hoursAhead(24), 'v3-future'));

    const active = await stores.policies.activeForRegion(region, NOW());
    expect(active?.policyId).toBe(v2.policyId);
    // The reassembled raw document round-trips the SHARED validator intact.
    const validated = validatePolicy(active?.document);
    expect(validated.ok).toBe(true);
    expect(await stores.policies.hasOnlyFutureRows(region, NOW())).toBe(false);

    await stores.policies.insert(policyDocOf(futureRegion, hoursAhead(24), 'future-only'));
    expect(await stores.policies.activeForRegion(futureRegion, NOW())).toBeNull();
    expect(await stores.policies.hasOnlyFutureRows(futureRegion, NOW())).toBe(true);

    const versions = await stores.policies.listByRegion(region);
    expect(versions).toHaveLength(3);
  });

  it('policy audit chain: appends link, verify passes, and a parent slot is single-writer', async () => {
    const deps = { policyAudit: stores.policyAudit, now: clock, uuid };
    const first = await appendPolicyAudit(deps, {
      policyId: randomUUID(),
      countryOrRegion: region,
      changeType: 'create',
      changedByRef: 'ref:wsn-it-a',
      previousValue: null,
      newValue: { note: 'first' },
      reason: 'integration fixture',
      approvalRef: null,
    });
    policyAuditIds.push(first.changeId);
    const second = await appendPolicyAudit(deps, {
      policyId: first.policyId,
      countryOrRegion: region,
      changeType: 'update',
      changedByRef: 'ref:wsn-it-a',
      previousValue: { note: 'first' },
      newValue: { note: 'second' },
      reason: 'integration fixture',
      approvalRef: 'counsel:fixture',
    });
    policyAuditIds.push(second.changeId);
    expect(second.prevHash).toBe(first.integrityHash);

    const verification = await verifyPolicyAuditChain({ policyAudit: stores.policyAudit });
    expect(verification.valid).toBe(true);

    // The fork-proof partial unique: first's parent slot is already taken by
    // second, so a competing append against the SAME head resolves to null
    // (the chain engine's retry signal) — never a second child.
    const forkBase = {
      changeId: randomUUID(),
      policyId: first.policyId,
      countryOrRegion: region,
      changeType: 'update' as const,
      changedByRef: 'ref:wsn-it-b',
      previousValue: null,
      newValue: { note: 'fork attempt' },
      reason: 'fork attempt',
      approvalRef: null,
      prevHash: first.integrityHash,
      createdAt: NOW(),
    };
    const fork = await stores.policyAudit.appendChained({
      ...forkBase,
      integrityHash: computePolicyAuditHash(forkBase),
    });
    expect(fork).toBeNull();
  });

  it('the policy audit table rejects UPDATE and DELETE at the trigger level', async () => {
    const changeId = policyAuditIds[0] as string;
    await expectTriggerRejection(
      db
        .update(jurisdictionPolicyAudits)
        .set({ reason: 'tampered' })
        .where(eq(jurisdictionPolicyAudits.changeId, changeId)),
      /append-only/,
    );
    await expectTriggerRejection(
      db.delete(jurisdictionPolicyAudits).where(eq(jurisdictionPolicyAudits.changeId, changeId)),
      /append-only/,
    );
  });

  it('case insert is idempotent on the partial unique; CAS transitions arbitrate stale writers', async () => {
    const key = `wsn-it:${randomUUID()}`;
    const original = track(await stores.cases.insert(caseOf(userId, { idempotencyKey: key })));
    // A concurrent duplicate (different caseId, same key) returns THE EXISTING row.
    const duplicate = await stores.cases.insert(caseOf(userId, { idempotencyKey: key }));
    expect(duplicate.caseId).toBe(original.caseId);
    expect(await stores.cases.findByIdempotencyKey(key)).not.toBeNull();

    const moved = await stores.cases.transition(
      original.caseId,
      'open',
      { reviewState: 'assigned', assignedTo: userId },
      NOW(),
    );
    expect(moved?.reviewState).toBe('assigned');
    // The stale writer (still believing 'open') loses the CAS.
    const stale = await stores.cases.transition(
      original.caseId,
      'open',
      { reviewState: 'investigating' },
      NOW(),
    );
    expect(stale).toBeNull();

    const listed = await stores.cases.listByStates(['assigned'], 100);
    expect(listed.some((c) => c.caseId === original.caseId)).toBe(true);
  });

  it('countOpenHighRisk counts open high/critical cases only', async () => {
    const subject = randomUUID();
    track(await stores.cases.insert(caseOf(subject, { riskLevel: 'high' })));
    track(
      await stores.cases.insert(
        caseOf(subject, {
          riskLevel: 'critical',
          reviewState: 'resolved',
          resolution: {
            outcome: 'cleared',
            notes: 'fixture',
            resolved_by: userId,
            resolved_at: NOW(),
          },
        }),
      ),
    );
    track(await stores.cases.insert(caseOf(subject, { riskLevel: 'low' })));
    expect(await stores.cases.countOpenHighRisk(subject)).toBe(1);
    expect((await stores.cases.listBySubject(subject, 10)).length).toBe(3);
  });

  it('case audit chain: per-case genesis, GUC-gated delete, and no casual DELETE path', async () => {
    const record = track(await stores.cases.insert(caseOf(userId)));
    const deps = { caseAudit: stores.caseAudit, now: clock, uuid };
    await appendCaseAudit(deps, {
      caseId: record.caseId,
      action: 'case_created',
      actorRef: 'ref:wsn-it',
      beforeState: null,
      afterState: 'open',
      note: null,
    });
    await appendCaseAudit(deps, {
      caseId: record.caseId,
      action: 'assigned',
      actorRef: 'ref:wsn-it',
      beforeState: 'open',
      afterState: 'assigned',
      note: 'fixture',
    });
    const verification = await verifyCaseAuditChain({ caseAudit: stores.caseAudit }, record.caseId);
    expect(verification.valid).toBe(true);
    expect(verification.chainedEntries).toBe(2);

    // One genesis per case: a second prevHash=null entry resolves to null.
    const genesisBase = {
      auditId: randomUUID(),
      caseId: record.caseId,
      action: 'case_created',
      actorRef: 'ref:wsn-it-b',
      beforeState: null,
      afterState: 'open',
      note: null,
      prevHash: null,
      createdAt: NOW(),
    };
    const forkedGenesis = await stores.caseAudit.appendChained({
      ...genesisBase,
      integrityHash: computeCaseAuditHash(genesisBase),
    });
    expect(forkedGenesis).toBeNull();

    // A second case starts its OWN genesis (the unique is per case).
    const sibling = track(await stores.cases.insert(caseOf(userId)));
    await appendCaseAudit(deps, {
      caseId: sibling.caseId,
      action: 'case_created',
      actorRef: 'ref:wsn-it',
      beforeState: null,
      afterState: 'open',
      note: null,
    });
    expect((await stores.caseAudit.listChained(sibling.caseId)).length).toBe(1);

    // A casual DELETE (no GUC) is rejected by the trigger…
    await expectTriggerRejection(
      db.execute(
        sql`DELETE FROM "compliance"."compliance_case_audit" WHERE case_id = ${record.caseId}`,
      ),
      /append-only/,
    );
    // …and the sanctioned retention path removes the trail.
    expect(await stores.caseAudit.deleteByCase(record.caseId)).toBe(2);
    expect(await stores.caseAudit.listChained(record.caseId)).toHaveLength(0);
  });

  it('deleteCascade removes trail + case in one sanctioned transaction; a SAR blocks it', async () => {
    const doomed = await stores.cases.insert(caseOf(userId));
    await appendCaseAudit(
      { caseAudit: stores.caseAudit, now: clock, uuid },
      {
        caseId: doomed.caseId,
        action: 'case_created',
        actorRef: 'ref:wsn-it',
        beforeState: null,
        afterState: 'open',
        note: null,
      },
    );
    await stores.cases.deleteCascade(doomed.caseId);
    expect(await stores.cases.getById(doomed.caseId)).toBeNull();
    expect(await stores.caseAudit.listChained(doomed.caseId)).toHaveLength(0);

    // A filed-SAR reference makes the case row undeletable (FK RESTRICT) —
    // retention can never sweep a case out from under a regulatory record.
    const held = track(await stores.cases.insert(caseOf(userId, { triggerType: 'sanctions' })));
    await stores.sars.insert({
      sarId: randomUUID(),
      caseId: held.caseId,
      jurisdiction: 'ZZ',
      status: 'draft',
      narrative: 'integration fixture narrative',
      filingRef: null,
      filedAt: null,
      partnerFiled: false,
      createdByRef: 'ref:counsel-fixture',
      approvedByRef: null,
      createdAt: NOW(),
      updatedAt: NOW(),
    });
    await expect(stores.cases.deleteCascade(held.caseId)).rejects.toThrow();
    expect(await stores.cases.getById(held.caseId)).not.toBeNull();
  });

  it('scrubUserSubject NULLs user subjects except under legal hold; anonymize scrubs the rest', async () => {
    const erasureUser = randomUUID();
    const plain = track(await stores.cases.insert(caseOf(erasureUser)));
    const held = track(
      await stores.cases.insert(
        caseOf(erasureUser, {
          retentionPolicy: {
            retention_period_days: 1825,
            deletion_date: hoursAhead(24),
            legal_hold: true,
          },
        }),
      ),
    );
    const outcome = await stores.cases.scrubUserSubject(erasureUser);
    expect(outcome.scrubbed).toEqual([plain.caseId]);
    expect(outcome.heldBack).toEqual([held.caseId]);
    expect((await stores.cases.getById(plain.caseId))?.userIdOrRoomId).toBeNull();
    expect((await stores.cases.getById(held.caseId))?.userIdOrRoomId).toBe(erasureUser);

    await stores.cases.anonymize(held.caseId, NOW());
    const anonymized = await stores.cases.getById(held.caseId);
    expect(anonymized?.userIdOrRoomId).toBeNull();
    expect(anonymized?.partnerCaseRef).toBeNull();
  });

  it('listExpired returns past-deletion-date cases NOT under legal hold', async () => {
    const expired = track(
      await stores.cases.insert(
        caseOf(randomUUID(), {
          retentionPolicy: {
            retention_period_days: 1,
            deletion_date: hoursAgo(1),
            legal_hold: false,
          },
        }),
      ),
    );
    const heldExpired = track(
      await stores.cases.insert(
        caseOf(randomUUID(), {
          retentionPolicy: {
            retention_period_days: 1,
            deletion_date: hoursAgo(1),
            legal_hold: true,
          },
        }),
      ),
    );
    const listed = await stores.cases.listExpired(NOW(), 1000);
    const ids = listed.map((c) => c.caseId);
    expect(ids).toContain(expired.caseId);
    expect(ids).not.toContain(heldExpired.caseId);
  });

  it('region declarations upsert/get/delete against the live user FK', async () => {
    const at = NOW();
    await stores.declarations.upsert({
      userId,
      declaredRegion: region,
      status: 'pending',
      verificationLevel: 'unverified',
      evidenceRef: null,
      verifiedAt: null,
      verifiedBy: null,
      createdAt: at,
      updatedAt: at,
    });
    const verified = await stores.declarations.upsert({
      userId,
      declaredRegion: region,
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: 'evidence:fixture',
      verifiedAt: NOW(),
      verifiedBy: userId,
      createdAt: at,
      updatedAt: NOW(),
    });
    expect(verified.status).toBe('verified');
    expect((await stores.declarations.get(userId))?.verificationLevel).toBe('reviewer_verified');
    expect(await stores.declarations.delete(userId)).toBe(true);
    expect(await stores.declarations.get(userId)).toBeNull();
  });

  it('disclosures are publish-immutable; acks are idempotent and erased by NULLing only', async () => {
    const disclosureId = `risk-${randomUUID().slice(0, 8)}`;
    const version = {
      id: randomUUID(),
      disclosureId,
      region,
      version: 1,
      locale: 'en',
      title: 'Crypto-asset risk disclosure',
      contentMd: 'You can lose everything you deposit.',
      requiresAcknowledgment: true,
      publishedAt: NOW(),
    };
    await stores.disclosures.publish(version);
    // Publish-immutable: the SAME (id, region, version, locale) throws…
    await expect(stores.disclosures.publish({ ...version, id: randomUUID() })).rejects.toThrow();
    // …and the trigger blocks in-place edits of published legal copy.
    await expectTriggerRejection(
      db
        .update(disclosureVersions)
        .set({ contentMd: 'weakened' })
        .where(eq(disclosureVersions.id, version.id)),
      /immutable|publish/,
    );
    expect((await stores.disclosures.listForRegion(region))[0]?.disclosureId).toBe(disclosureId);
    expect(await stores.disclosures.get(disclosureId, region, 1)).not.toBeNull();

    const ack = {
      id: randomUUID(),
      userId,
      disclosureId,
      version: 1,
      region,
      acknowledgedAt: NOW(),
    };
    await stores.acks.record(ack);
    // Idempotent on the (user, disclosure, version) partial unique.
    const replay = await stores.acks.record({ ...ack, id: randomUUID() });
    expect(replay.id).toBe(ack.id);
    expect(await stores.acks.has(userId, disclosureId, 1)).toBe(true);

    // The consent evidence is append-only: content edits are rejected…
    await expectTriggerRejection(
      db
        .update(disclosureAcknowledgments)
        .set({ region: 'XX' })
        .where(eq(disclosureAcknowledgments.id, ack.id)),
      /append-only/,
    );
    // …while the right-to-erasure NULLing of user_id is the ONE permitted write.
    expect(await stores.acks.anonymizeUser(userId)).toBe(1);
    expect(await stores.acks.has(userId, disclosureId, 1)).toBe(false);
    expect(await stores.acks.listByUser(userId)).toHaveLength(0);
  });

  it('wallet pins: one active pin per wallet (idempotent), release, re-pin, purge', async () => {
    const walletAccountId = randomUUID();
    const pinOf = () => ({
      id: randomUUID(),
      walletAccountId,
      reason: 'suspected_compromise',
      pinnedByRef: 'ref:wsn-it',
      createdAt: NOW(),
      releasedAt: null,
      releasedByRef: null,
    });
    const first = await stores.pins.pin(pinOf());
    // The active-pin partial unique arbitrates: the second pin RETURNS the first.
    const second = await stores.pins.pin(pinOf());
    expect(second.id).toBe(first.id);
    expect((await stores.pins.activeForWallet(walletAccountId))?.id).toBe(first.id);

    expect(await stores.pins.release(walletAccountId, 'ref:wsn-it', NOW())).toBe(true);
    expect(await stores.pins.release(walletAccountId, 'ref:wsn-it', NOW())).toBe(false);
    expect(await stores.pins.activeForWallet(walletAccountId)).toBeNull();

    // A released wallet can be pinned again (the unique is on ACTIVE pins).
    const rePinned = await stores.pins.pin(pinOf());
    expect(rePinned.id).not.toBe(first.id);
    expect(await stores.pins.purgeForWallets([walletAccountId])).toBe(2);
  });

  it('SAR and lawful-access records round-trip with status filtering', async () => {
    const record = track(await stores.cases.insert(caseOf(userId, { triggerType: 'fraud' })));
    const sar = await stores.sars.insert({
      sarId: randomUUID(),
      caseId: record.caseId,
      jurisdiction: 'ZZ',
      status: 'draft',
      narrative: 'A counsel-authored narrative.',
      filingRef: null,
      filedAt: null,
      partnerFiled: false,
      createdByRef: 'ref:counsel-fixture',
      approvedByRef: null,
      createdAt: NOW(),
      updatedAt: NOW(),
    });
    const approved = await stores.sars.update(
      sar.sarId,
      { status: 'approved', approvedByRef: 'ref:counsel-approver' },
      NOW(),
    );
    expect(approved?.status).toBe('approved');
    expect((await stores.sars.listByCase(record.caseId))[0]?.sarId).toBe(sar.sarId);
    expect((await stores.sars.list(50)).some((s) => s.sarId === sar.sarId)).toBe(true);

    const request = await stores.lawfulAccess.insert({
      requestId: trackRequest(randomUUID()),
      agency: 'Fixture Agency',
      jurisdiction: 'ZZ',
      legalBasis: 'court_order',
      scope: {
        subject_kind: 'user',
        subject_ref: userId,
        time_range_start: null,
        time_range_end: null,
      },
      contact: 'legal@fixture.example',
      status: 'received',
      reviewNote: null,
      reviewedByRef: null,
      productionSummary: null,
      userNotifiedAt: null,
      caseId: record.caseId,
      createdAt: NOW(),
      updatedAt: NOW(),
    });
    const reviewed = await stores.lawfulAccess.update(
      request.requestId,
      { status: 'under_review', reviewedByRef: 'ref:counsel-fixture' },
      NOW(),
    );
    expect(reviewed?.status).toBe('under_review');
    const underReview = await stores.lawfulAccess.list('under_review', 100);
    expect(underReview.some((r) => r.requestId === request.requestId)).toBe(true);
  });
});

describe.skipIf(!REDIS_URL)('WS-N compliance Redis adapters (live Redis)', () => {
  const url = REDIS_URL as string;
  const openedClients: IORedis[] = [];
  const open = (): IORedis => {
    const client = new IORedis(url);
    openedClients.push(client);
    return client;
  };

  afterAll(async () => {
    await Promise.all(openedClients.map((client) => client.quit().catch(() => {})));
  });

  it('velocity reserve is exact-decimal: a sum floats would round away is rejected', async () => {
    const store = new RedisVelocityStore(open());
    const key = `wsn-it:${randomUUID()}`;
    // 2^53 + 1 is NOT representable as a double: float math would collapse
    // 2·(2^53+1) + 1 back to exactly the limit and wrongly admit the third
    // check.  Exact string math rejects it.
    const unsafeAmount = '9007199254740993'; // 2^53 + 1
    const limit = '18014398509481986'; // exactly 2 * (2^53 + 1)
    const base = {
      key,
      nowMs: Date.now(),
      windowMs: 60_000,
      maxCount: 10,
      maxVolumeMinorUnits: limit,
    };
    expect(await store.reserve({ ...base, amountMinorUnits: unsafeAmount })).toBe('ok');
    expect(await store.reserve({ ...base, amountMinorUnits: unsafeAmount })).toBe('ok');
    expect(await store.reserve({ ...base, amountMinorUnits: '1' })).toBe('exceeded');
  });

  it('velocity reserve shares one window across instances and enforces the count cap', async () => {
    const a = new RedisVelocityStore(open());
    const b = new RedisVelocityStore(open());
    const key = `wsn-it:${randomUUID()}`;
    const base = {
      key,
      nowMs: Date.now(),
      windowMs: 60_000,
      amountMinorUnits: '100',
      maxCount: 2,
      maxVolumeMinorUnits: '1000000',
    };
    expect(await a.reserve(base)).toBe('ok');
    expect(await b.reserve(base)).toBe('ok');
    // The third check exceeds the SHARED count — whichever pod it lands on.
    expect(await a.reserve(base)).toBe('exceeded');
    // Outside the window the pruned key admits again (sliding, not fixed).
    expect(await b.reserve({ ...base, nowMs: base.nowMs + 120_000 })).toBe('ok');
  });

  it('velocity reserve rejects a malformed amount without touching the window', async () => {
    const store = new RedisVelocityStore(open());
    const key = `wsn-it:${randomUUID()}`;
    const base = {
      key,
      nowMs: Date.now(),
      windowMs: 60_000,
      maxCount: 1,
      maxVolumeMinorUnits: '1000',
    };
    expect(await store.reserve({ ...base, amountMinorUnits: '-5' })).toBe('exceeded');
    expect(await store.reserve({ ...base, amountMinorUnits: '1.5' })).toBe('exceeded');
    // The malformed attempts recorded nothing: a valid check still fits.
    expect(await store.reserve({ ...base, amountMinorUnits: '10' })).toBe('ok');
  });

  it('screening cache honors per-key TTL', async () => {
    const cache = new RedisScreeningCacheStore(open());
    const key = `wsn-it:${randomUUID()}`;
    await cache.set(key, 'clear', 150);
    expect(await cache.get(key)).toBe('clear');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await cache.get(key)).toBeNull();
  });

  it('policy invalidation crosses instances; a malformed message invalidates everything', async () => {
    const received: Array<string | null> = [];
    const publisherSide = new RedisPolicyInvalidationBroadcaster(open(), open());
    const subscriberSide = new RedisPolicyInvalidationBroadcaster(open(), open());
    subscriberSide.subscribe((invalidatedRegion) => received.push(invalidatedRegion));
    // Subscription registration is asynchronous under the hood.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await publisherSide.publish('DE');
    await publisherSide.publish(null);
    // A hostile/corrupt frame on the channel — fail-closed maps it to null.
    await open().publish('compliance:policy:invalidate', 'not-json');
    const deadline = Date.now() + 2_000;
    while (received.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(received).toEqual(['DE', null, null]);
  });
});
