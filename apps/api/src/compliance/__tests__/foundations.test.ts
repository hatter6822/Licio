// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N foundations: the identity-free region ladder (WS-N.1.1b), the two
// hash chains (WS-N.1.1g / 2.1c — append, verify, tamper, fork), the no-key
// content filter (WS-N.2.3e), the disclosure gate (WS-N.1.2d), retention +
// erasure (WS-N.2.1d), and the fail-closed compliance.* config loader.
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../../events/stores.js';
import {
  appendPolicyAuditInTx,
  computeCaseAuditHash,
  computePolicyAuditHash,
  runChainedUnit,
  verifyPolicyAuditChain,
} from '../audit.js';
import { createCase, setLegalHold } from '../cases.js';
import { loadComplianceConfig, validateComplianceConfigValue } from '../config.js';
import { acknowledgeDisclosure, disclosureGate, listDisclosuresForUser } from '../disclosures.js';
import { NO_KEY_WARNING, scanForKeyMaterial } from '../no-key-filter.js';
import { resolveRegion } from '../region.js';
import { runRetentionSweep, scrubUserSubjectForErasure } from '../retention.js';
import {
  buildCaseDeps,
  buildDisclosureDeps,
  createInMemoryComplianceServices,
} from '../services.js';
import { InMemoryRegionDeclarationStore } from '../stores.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const USER = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';

function services() {
  return createInMemoryComplianceServices({
    configStore: new InMemoryPwattConfigStore(),
    now: () => NOW,
  });
}

describe('the region resolution ladder (WS-N.1.1b — identity-free)', () => {
  it('verified declaration > locale subtag > unknown, with the basis reported', async () => {
    const declarations = new InMemoryRegionDeclarationStore();
    const deps = { declarations, localeRegion: async () => 'GB' };
    expect(await resolveRegion(deps, USER)).toEqual({ region: 'GB', basis: 'locale_subtag' });
    await declarations.upsert({
      userId: USER,
      declaredRegion: 'DE',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(await resolveRegion(deps, USER)).toEqual({
      region: 'DE',
      basis: 'verified_declaration',
    });
    expect(
      await resolveRegion(
        { declarations: new InMemoryRegionDeclarationStore(), localeRegion: async () => null },
        USER,
      ),
    ).toEqual({ region: null, basis: 'unknown' });
  });

  it('pending declarations fall to locale; a declaration-read OUTAGE fails CLOSED to unknown', async () => {
    const declarations = new InMemoryRegionDeclarationStore();
    await declarations.upsert({
      userId: USER,
      declaredRegion: 'DE',
      status: 'pending',
      verificationLevel: 'unverified',
      evidenceRef: null,
      verifiedAt: null,
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    // A SUCCESSFUL read that finds no verified declaration falls to the weaker
    // locale rung — we KNOW there is nothing stronger to lose.
    expect(await resolveRegion({ declarations, localeRegion: async () => 'FR' }, USER)).toEqual({
      region: 'FR',
      basis: 'locale_subtag',
    });
    // But a declaration-store OUTAGE must NOT be read as "no verified
    // declaration": a member whose verified declaration names a BLOCKED region
    // would otherwise resolve to the more-permissive locale 'FR' and be allowed
    // the wallet links / testnet actions the stored declaration denies.  Fail
    // CLOSED to `unknown` — never down to a weaker, more permissive rung.
    const broken = {
      declarations: {
        get: async () => {
          throw new Error('down');
        },
      } as never,
      localeRegion: async () => 'FR',
    };
    expect(await resolveRegion(broken, USER)).toEqual({ region: null, basis: 'unknown' });
    // A LOCALE outage (declaration read fine, no verified decl) still fails to
    // unknown, not up — the locale rung is already the weakest permissive one.
    const localeDown = {
      declarations,
      localeRegion: async () => {
        throw new Error('locale down');
      },
    };
    expect(await resolveRegion(localeDown, USER)).toEqual({ region: null, basis: 'unknown' });
  });
});

describe('the policy audit chain (WS-N.1.1g)', () => {
  it('appends, verifies, and detects tampering + attribution rewrites', async () => {
    const s = services();
    // Through the REAL unit of work — the policy write's own path.
    const appendPolicyAudit = (input: Parameters<typeof appendPolicyAuditInTx>[2]) =>
      runChainedUnit(s.transactor, (stores) => appendPolicyAuditInTx(stores, s, input), 'test');
    await appendPolicyAudit({
      policyId: '11111111-1111-4111-8111-111111111111',
      countryOrRegion: 'DE',
      changeType: 'create',
      changedByRef: 'ref-a',
      previousValue: null,
      newValue: { v: 1 },
      reason: 'initial',
      approvalRef: null,
    });
    await appendPolicyAudit({
      policyId: '11111111-1111-4111-8111-111111111111',
      countryOrRegion: 'DE',
      changeType: 'update',
      changedByRef: 'ref-a',
      previousValue: { v: 1 },
      newValue: { v: 2 },
      reason: 'tighten',
      approvalRef: 'FOUR-EYES-1',
    });
    expect((await verifyPolicyAuditChain({ policyAudit: s.policyAudit })).valid).toBe(true);
    // Tamper: recompute must fail if ANY attribution field changes (W13).
    const entries = await s.policyAudit.listChained();
    const entry = entries[1];
    if (!entry) throw new Error('setup');
    expect(computePolicyAuditHash({ ...entry, changedByRef: 'ref-EVIL' })).not.toBe(
      entry.integrityHash,
    );
    expect(computePolicyAuditHash({ ...entry, reason: 'loosen' })).not.toBe(entry.integrityHash);
  });

  it('the fork-proof store rejects a second child for the same parent', async () => {
    const s = services();
    const head = await s.policyAudit.chainHead();
    expect(head).toBeNull();
    const base = {
      changeId: '22222222-2222-4222-8222-222222222222',
      policyId: '11111111-1111-4111-8111-111111111111',
      countryOrRegion: 'DE',
      changeType: 'create' as const,
      changedByRef: 'r',
      previousValue: null,
      newValue: {},
      reason: 'x',
      approvalRef: null,
      prevHash: null,
      createdAt: new Date(NOW).toISOString(),
    };
    const genesis = { ...base, integrityHash: computePolicyAuditHash(base) };
    expect(await s.policyAudit.appendChained(genesis)).not.toBeNull();
    // A SECOND genesis (same null parent) collides.
    const rival = {
      ...base,
      changeId: '33333333-3333-4333-8333-333333333333',
      integrityHash: computePolicyAuditHash({ ...base, reason: 'rival' }),
    };
    expect(await s.policyAudit.appendChained(rival)).toBeNull();
  });

  it('case-audit hashes cover every attribution field too', () => {
    const base = {
      auditId: 'a',
      caseId: 'c',
      action: 'note',
      actorRef: 'ref',
      beforeState: 'open',
      afterState: 'open',
      note: 'n',
      prevHash: null,
      createdAt: new Date(NOW).toISOString(),
    };
    const hash = computeCaseAuditHash(base);
    expect(computeCaseAuditHash({ ...base, actorRef: 'other' })).not.toBe(hash);
    expect(computeCaseAuditHash({ ...base, note: 'changed' })).not.toBe(hash);
    expect(computeCaseAuditHash({ ...base, afterState: 'resolved' })).not.toBe(hash);
  });
});

describe('the no-key content filter (WS-N.2.3e)', () => {
  it('detects 64-hex private keys in BOTH the bare and 0x-prefixed forms', () => {
    const key = 'e9873d79c6d87dc0fb6a5778633389f4453213303da61f20bd67fc233aa33262';
    expect(scanForKeyMaterial(`here is my key ${key} please help`)).toEqual({
      detected: true,
      kind: 'private_key_hex',
      warning: NO_KEY_WARNING,
    });
    // A 0x-prefixed 64-hex value is a private key AND a transaction hash —
    // the syntax is identical, so the scanner cannot tell them apart. Storing
    // a pasted key is irreversible; refusing a hash in this free-text blurb
    // costs a warning (links belong in the structured evidence field), so it
    // fails closed.
    expect(scanForKeyMaterial(`my transfer 0x${key} went to the wrong room`)).toEqual({
      detected: true,
      kind: 'private_key_hex',
      warning: NO_KEY_WARNING,
    });
    // Part of a LONGER hex blob is a different artifact (e.g. a signature).
    expect(scanForKeyMaterial(`${key}ff`).detected).toBe(false);
    expect(scanForKeyMaterial(`0x${key}ff`).detected).toBe(false);
    // A shorter hex run is not a key.
    expect(scanForKeyMaterial(`0x${key.slice(0, 40)}`).detected).toBe(false);
  });

  it('detects 12/24-word BIP-39 phrases, embedded mid-sentence included', () => {
    const phrase12 =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    expect(scanForKeyMaterial(phrase12)).toEqual({
      detected: true,
      kind: 'seed_phrase',
      warning: NO_KEY_WARNING,
    });
    expect(
      scanForKeyMaterial(`please help, my phrase is ${phrase12}, did I lose it?`).detected,
    ).toBe(true);
    // Ordinary prose never trips it (non-wordlist words break the run).
    expect(
      scanForKeyMaterial(
        'I sent a payment to the wrong room yesterday and would like to understand what options exist for recovery, thanks so much for the help',
      ).detected,
    ).toBe(false);
    // Eleven wordlist words in a row (below the shortest real phrase) pass.
    expect(
      scanForKeyMaterial(
        'abandon ability able about above absent absorb abstract absurd abuse access',
      ).detected,
    ).toBe(false);
  });
});

describe('the disclosure gate (WS-N.1.2d)', () => {
  async function withPolicy(s = services()) {
    await s.declarations.upsert({
      userId: USER,
      declaredRegion: 'DE',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    await s.policies.insert({
      policyId: '44444444-4444-4444-8444-444444444444',
      countryOrRegion: 'DE',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      document: {
        policy_id: '44444444-4444-4444-8444-444444444444',
        country_or_region: 'DE',
        feature_flags: {
          wallet_connection: 'testnet',
          testnet_transactions: 'testnet',
          production_payments: 'disabled',
          treasury_operations: 'disabled',
          governance: 'disabled',
        },
        asset_flags: {},
        age_gate_policy: {
          wallet_connection: { required_band: 'adult' },
          testnet_transactions: { required_band: 'adult' },
          production_payments: { required_band: 'adult' },
          treasury_operations: { required_band: 'adult' },
          governance: { required_band: 'adult' },
        },
        kyc_policy: {},
        disclosure_refs: [{ id: 'risk-general', version: 2, locales: ['en'] }],
        legal_approval_ref: null,
        effective_at: '2026-01-01T00:00:00.000Z',
      },
      createdAt: new Date(NOW).toISOString(),
    });
    await s.disclosures.publish({
      id: '55555555-5555-4555-8555-555555555555',
      disclosureId: 'risk-general',
      region: 'DE',
      version: 2,
      locale: 'en',
      title: 'Risk disclosure',
      contentMd: 'On-chain transactions are irreversible. Crypto is optional.',
      requiresAcknowledgment: true,
      publishedByRef: 'counsel-ref',
      publishedAt: new Date(NOW).toISOString(),
    });
    return s;
  }

  it('requires the CURRENT version before the first financial action; a new version re-prompts', async () => {
    const s = await withPolicy();
    const deps = buildDisclosureDeps(s);
    let gate = await disclosureGate(deps, USER);
    expect(gate.required).toBe(true);
    expect(gate.missing[0]?.id).toBe('risk-general');
    // Acknowledging a NON-EXISTENT version is rejected (no gate bypass).
    const wrong = await acknowledgeDisclosure(deps, {
      userId: USER,
      disclosureId: 'risk-general',
      version: 9,
    });
    expect(wrong.ok).toBe(false);
    const ack = await acknowledgeDisclosure(deps, {
      userId: USER,
      disclosureId: 'risk-general',
      version: 2,
    });
    expect(ack.ok).toBe(true);
    gate = await disclosureGate(deps, USER);
    expect(gate.required).toBe(false);
    const listed = await listDisclosuresForUser(deps, USER);
    expect(listed[0]?.acknowledged).toBe(true);
    // Idempotent re-ack.
    const again = await acknowledgeDisclosure(deps, {
      userId: USER,
      disclosureId: 'risk-general',
      version: 2,
    });
    expect(again.ok).toBe(true);
  });

  it('fails closed: an unreadable ack store reports the requirement missing', async () => {
    const s = await withPolicy();
    s.acks.has = async () => {
      throw new Error('down');
    };
    const gate = await disclosureGate(buildDisclosureDeps(s), USER);
    expect(gate.required).toBe(true);
  });

  it('an ack is REGION-scoped: the same id+version elsewhere does not satisfy the gate', async () => {
    const s = await withPolicy();
    const deps = buildDisclosureDeps(s);
    // Acknowledge DE's risk-general v2.
    expect(
      (
        await acknowledgeDisclosure(deps, {
          userId: USER,
          disclosureId: 'risk-general',
          version: 2,
        })
      ).ok,
    ).toBe(true);
    expect((await disclosureGate(deps, USER)).required).toBe(false);

    // FR reuses the id+version for DIFFERENT counsel-authored text, and
    // requires it too.  Moving to FR must re-prompt: the DE acknowledgment is
    // evidence about DE's wording only.
    await s.policies.insert({
      policyId: '77777777-7777-4777-8777-777777777777',
      countryOrRegion: 'FR',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      document: {
        policy_id: '77777777-7777-4777-8777-777777777777',
        country_or_region: 'FR',
        feature_flags: {
          wallet_connection: 'testnet',
          testnet_transactions: 'testnet',
          production_payments: 'disabled',
          treasury_operations: 'disabled',
          governance: 'disabled',
        },
        asset_flags: {},
        age_gate_policy: {
          wallet_connection: { required_band: 'adult' },
          testnet_transactions: { required_band: 'adult' },
          production_payments: { required_band: 'adult' },
          treasury_operations: { required_band: 'adult' },
          governance: { required_band: 'adult' },
        },
        kyc_policy: {},
        disclosure_refs: [{ id: 'risk-general', version: 2, locales: ['fr'] }],
        legal_approval_ref: null,
        effective_at: '2026-01-01T00:00:00.000Z',
      },
      createdAt: new Date(NOW).toISOString(),
    });
    await s.disclosures.publish({
      id: '88888888-8888-4888-8888-888888888888',
      disclosureId: 'risk-general',
      region: 'FR',
      version: 2,
      locale: 'fr',
      title: 'Avertissement sur les risques',
      contentMd: 'Texte français distinct — les obligations diffèrent.',
      requiresAcknowledgment: true,
      publishedByRef: 'counsel-ref',
      publishedAt: new Date(NOW).toISOString(),
    });
    await s.declarations.upsert({
      userId: USER,
      declaredRegion: 'FR',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    const inFrance = await disclosureGate(deps, USER);
    expect(inFrance.region).toBe('FR');
    expect(inFrance.required).toBe(true);
    expect(inFrance.missing[0]?.id).toBe('risk-general');
    // The list shows FR's version as UNacknowledged…
    expect((await listDisclosuresForUser(deps, USER))[0]?.acknowledged).toBe(false);
    // …and acknowledging it clears FR without disturbing the DE evidence.
    expect(
      (
        await acknowledgeDisclosure(deps, {
          userId: USER,
          disclosureId: 'risk-general',
          version: 2,
        })
      ).ok,
    ).toBe(true);
    expect((await disclosureGate(deps, USER)).required).toBe(false);
    expect(await s.acks.has(USER, 'risk-general', 2, 'DE')).toBe(true);
    expect(await s.acks.has(USER, 'risk-general', 2, 'FR')).toBe(true);
  });

  it('publish-immutability: the same version cannot be re-published', async () => {
    const s = await withPolicy();
    await expect(
      s.disclosures.publish({
        id: '66666666-6666-4666-8666-666666666666',
        disclosureId: 'risk-general',
        region: 'DE',
        version: 2,
        locale: 'en',
        title: 'Edited',
        contentMd: 'weakened wording',
        requiresAcknowledgment: true,
        publishedByRef: 'counsel-ref',
        publishedAt: new Date(NOW).toISOString(),
      }),
    ).rejects.toThrow();
  });
});

describe('retention + erasure (WS-N.2.1d / WS-N.2.1a)', () => {
  it('deletes expired cases thoroughly, skips legal holds, reports the summary', async () => {
    const s = services();
    const deps = buildCaseDeps(s);
    const expired = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'velocity',
      riskLevel: 'low',
      note: 'old',
    });
    const held = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'sanctions',
      riskLevel: 'critical',
      note: 'held',
    });
    if (!expired.ok || !held.ok) throw new Error('setup');
    // Force both past their deletion dates; hold the second.
    await s.cases.update(
      expired.record.caseId,
      {
        retentionPolicy: {
          retention_period_days: 1,
          deletion_date: '2026-01-01T00:00:00.000Z',
          legal_hold: false,
          legal_hold_refs: [],
        },
      },
      new Date(NOW).toISOString(),
    );
    await setLegalHold(deps, {
      caseId: held.record.caseId,
      hold: true,
      holdRef: 'test-hold',
      actorUserId: USER,
      reason: 'regulatory',
    });
    await s.cases.update(
      held.record.caseId,
      {
        retentionPolicy: {
          retention_period_days: 1,
          deletion_date: '2026-01-01T00:00:00.000Z',
          legal_hold: true,
          legal_hold_refs: [],
        },
      },
      new Date(NOW).toISOString(),
    );
    const summary = await runRetentionSweep({
      caseDeps: deps,
      config: s.config,
      log: () => {},
      now: s.now,
    });
    expect(summary.deleted).toBe(1);
    expect(summary.held).toBe(1);
    expect(summary.errors).toBe(0);
    expect(await s.cases.getById(expired.record.caseId)).toBeNull();
    expect(await s.caseAudit.listChained(expired.record.caseId)).toHaveLength(0); // thorough
    expect(await s.cases.getById(held.record.caseId)).not.toBeNull();
    // Idempotent: a re-run finds nothing left.
    const rerun = await runRetentionSweep({
      caseDeps: deps,
      config: s.config,
      log: () => {},
      now: s.now,
    });
    expect(rerun.deleted).toBe(0);
  });

  it('erasure scrubs user subjects EXCEPT under legal hold (audited skip)', async () => {
    const s = services();
    const deps = buildCaseDeps(s);
    const plain = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'fraud',
      riskLevel: 'high',
      note: 'a',
    });
    const held = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'sanctions',
      riskLevel: 'critical',
      note: 'b',
    });
    if (!plain.ok || !held.ok) throw new Error('setup');
    await setLegalHold(deps, {
      caseId: held.record.caseId,
      hold: true,
      holdRef: 'test-hold',
      actorUserId: USER,
      reason: 'regulatory',
    });
    const result = await scrubUserSubjectForErasure({ caseDeps: deps, log: () => {} }, USER);
    expect(result).toEqual({ scrubbed: 1, heldBack: 1 });
    expect((await s.cases.getById(plain.record.caseId))?.userIdOrRoomId).toBeNull();
    expect((await s.cases.getById(held.record.caseId))?.userIdOrRoomId).toBe(USER);
    const trail = await s.caseAudit.listChained(held.record.caseId);
    expect(trail.some((entry) => entry.action === 'erasure_skipped_legal_hold')).toBe(true);
  });
});

describe('the fail-closed compliance.* config loader', () => {
  it('keeps the default on an invalid stored value and reports it', async () => {
    const store = new InMemoryPwattConfigStore();
    await store.set('compliance.policyCacheTtlMs', { value: -5 });
    await store.set('compliance.screeningTimeoutMs', { value: 10_000 });
    const problems: string[] = [];
    const config = await loadComplianceConfig(store, (key) => problems.push(key));
    expect(config.policyCacheTtlMs).toBe(5 * 60_000); // default kept
    expect(config.screeningTimeoutMs).toBe(10_000); // valid override applied
    expect(problems).toContain('policyCacheTtlMs');
  });

  it('rejects unknown keys and malformed velocity limits', () => {
    expect(validateComplianceConfigValue('nonsense', 1)).not.toBeNull();
    expect(
      validateComplianceConfigValue('velocityLimits', [
        { periodSeconds: 60, maxCount: 1, maxVolumeMinorUnits: '1.5' },
      ]),
    ).not.toBeNull();
    expect(
      validateComplianceConfigValue('velocityLimits', [
        { periodSeconds: 60, maxCount: 1, maxVolumeMinorUnits: '10' },
      ]),
    ).toBeNull();
  });

  it('a regional velocity override KEY must be a canonical region code (thread-S)', () => {
    const limits = [{ periodSeconds: 60, maxCount: 1, maxVolumeMinorUnits: '10' }];
    // A non-canonical key (`limitsForRegion` does an EXACT lookup with the
    // canonical code, so it would silently fall back to the global limits).
    expect(validateComplianceConfigValue('velocityRegionOverrides', { us: limits })).not.toBeNull();
    expect(
      validateComplianceConfigValue('velocityRegionOverrides', { 'us-ca': limits }),
    ).not.toBeNull();
    // Canonical region codes are accepted.
    expect(validateComplianceConfigValue('velocityRegionOverrides', { US: limits })).toBeNull();
    expect(
      validateComplianceConfigValue('velocityRegionOverrides', { 'US-CA': limits, EU: limits }),
    ).toBeNull();
  });

  it('retention trigger KEYS must be canonical CaseTriggerType values (config thread)', () => {
    // A typo'd key validates as any string today, then `createCaseInTx` indexes
    // `retentionDaysByTrigger[triggerType]` by the CLOSED enum (730-day fallback)
    // and the anonymize sweep matches `retentionAnonymizeTriggers` by EXACT
    // string — so a typo is a schedule that looks applied but never fires.
    expect(
      validateComplianceConfigValue('retentionDaysByTrigger', { sanction: 1_825 }),
    ).not.toBeNull();
    expect(
      validateComplianceConfigValue('retentionDaysByTrigger', { nonsense: 100 }),
    ).not.toBeNull();
    // A canonical (partial) map is accepted — the fallback covers the rest.
    expect(
      validateComplianceConfigValue('retentionDaysByTrigger', { sanctions: 1_825, fraud: 1_825 }),
    ).toBeNull();
    // Anonymize triggers are likewise constrained to the enum.
    expect(
      validateComplianceConfigValue('retentionAnonymizeTriggers', ['sanction']),
    ).not.toBeNull();
    expect(
      validateComplianceConfigValue('retentionAnonymizeTriggers', ['sanctions', 'fraud']),
    ).toBeNull();
  });

  it('SLA-by-risk and event-retention override KEYS are constrained to their vocabularies (config thread)', () => {
    // `slaDueAt` looks up `slaHoursByRisk[riskLevel]` by the CaseRiskLevel enum
    // (24h fallback); a typo silently keeps the default while reporting success.
    expect(validateComplianceConfigValue('slaHoursByRisk', { critcal: 2 })).not.toBeNull();
    expect(validateComplianceConfigValue('slaHoursByRisk', { high: 2, critical: 1 })).toBeNull();
    // `effectiveMaxDays` looks up `eventRetentionOverrides[tier]` by the
    // RetentionTier enum (base if absent); a typo never shortens what it names.
    expect(
      validateComplianceConfigValue('eventRetentionOverrides', { sensitive: 30 }),
    ).not.toBeNull();
    expect(
      validateComplianceConfigValue('eventRetentionOverrides', { attention_aggregated: 30 }),
    ).toBeNull();
  });
});

describe('the disclosure gate honors requires_acknowledgment (WS-N.1.2d)', () => {
  it('an INFORMATIONAL version never traps the user behind an unclearable gate', async () => {
    const s = services();
    await s.declarations.upsert({
      userId: USER,
      declaredRegion: 'DE',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    await s.policies.insert({
      policyId: '99999999-9999-4999-8999-999999999999',
      countryOrRegion: 'DE',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      document: {
        policy_id: '99999999-9999-4999-8999-999999999999',
        country_or_region: 'DE',
        feature_flags: {
          wallet_connection: 'testnet',
          testnet_transactions: 'testnet',
          production_payments: 'disabled',
          treasury_operations: 'disabled',
          governance: 'disabled',
        },
        asset_flags: {},
        age_gate_policy: {
          wallet_connection: { required_band: 'adult' },
          testnet_transactions: { required_band: 'adult' },
          production_payments: { required_band: 'adult' },
          treasury_operations: { required_band: 'adult' },
          governance: { required_band: 'adult' },
        },
        kyc_policy: {},
        disclosure_refs: [{ id: 'tax-info', version: 1, locales: ['en'] }],
        legal_approval_ref: null,
        effective_at: '2026-01-01T00:00:00.000Z',
      },
      createdAt: new Date(NOW).toISOString(),
    });
    // Published to be READ, not signed — the client renders no acknowledge
    // button for it, so requiring an ack would be an unclearable gate.
    await s.disclosures.publish({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      disclosureId: 'tax-info',
      region: 'DE',
      version: 1,
      locale: 'en',
      title: 'Tax information',
      contentMd: 'You may owe tax on gains. This is informational.',
      requiresAcknowledgment: false,
      publishedByRef: 'counsel-ref',
      publishedAt: new Date(NOW).toISOString(),
    });
    const gate = await disclosureGate(buildDisclosureDeps(s), USER);
    expect(gate.required).toBe(false);
    expect(gate.missing).toHaveLength(0);
  });

  it('a ref with NO published version still blocks (fail-closed)', async () => {
    const s = services();
    await s.declarations.upsert({
      userId: USER,
      declaredRegion: 'DE',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    await s.policies.insert({
      policyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      countryOrRegion: 'DE',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      document: {
        policy_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        country_or_region: 'DE',
        feature_flags: {
          wallet_connection: 'testnet',
          testnet_transactions: 'testnet',
          production_payments: 'disabled',
          treasury_operations: 'disabled',
          governance: 'disabled',
        },
        asset_flags: {},
        age_gate_policy: {
          wallet_connection: { required_band: 'adult' },
          testnet_transactions: { required_band: 'adult' },
          production_payments: { required_band: 'adult' },
          treasury_operations: { required_band: 'adult' },
          governance: { required_band: 'adult' },
        },
        kyc_policy: {},
        disclosure_refs: [{ id: 'never-published', version: 3, locales: ['en'] }],
        legal_approval_ref: null,
        effective_at: '2026-01-01T00:00:00.000Z',
      },
      createdAt: new Date(NOW).toISOString(),
    });
    // The region's policy demands a disclosure counsel has not published; real
    // funds must not flow on a promise that was never made.
    const gate = await disclosureGate(buildDisclosureDeps(s), USER);
    expect(gate.required).toBe(true);
    expect(gate.missing[0]?.id).toBe('never-published');
  });
});

describe('the disclosure gate requires EVERY locale the policy names (WS-N.1.2d)', () => {
  async function regionRequiring(s: ReturnType<typeof services>, locales: string[]) {
    await s.declarations.upsert({
      userId: USER,
      declaredRegion: 'DE',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    await s.policies.insert({
      policyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      countryOrRegion: 'DE',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      document: {
        policy_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        country_or_region: 'DE',
        feature_flags: {
          wallet_connection: 'testnet',
          testnet_transactions: 'testnet',
          production_payments: 'disabled',
          treasury_operations: 'disabled',
          governance: 'disabled',
        },
        asset_flags: {},
        age_gate_policy: {
          wallet_connection: { required_band: 'adult' },
          testnet_transactions: { required_band: 'adult' },
          production_payments: { required_band: 'adult' },
          treasury_operations: { required_band: 'adult' },
          governance: { required_band: 'adult' },
        },
        kyc_policy: {},
        disclosure_refs: [{ id: 'risk-general', version: 1, locales }],
        legal_approval_ref: null,
        effective_at: '2026-01-01T00:00:00.000Z',
      },
      createdAt: new Date(NOW).toISOString(),
    });
  }
  const publish = (s: ReturnType<typeof services>, locale: string, requiresAck = true) =>
    s.disclosures.publish({
      id: `${locale}-1111-4111-8111-111111111111`,
      disclosureId: 'risk-general',
      region: 'DE',
      version: 1,
      locale,
      title: `Risk (${locale})`,
      contentMd: `Localized legal text for ${locale}.`,
      requiresAcknowledgment: requiresAck,
      publishedByRef: 'counsel-ref',
      publishedAt: new Date(NOW).toISOString(),
    });

  it('a ref whose OTHER required locale was never published keeps blocking', async () => {
    const s = services();
    await regionRequiring(s, ['en', 'de']);
    await publish(s, 'en');
    const deps = buildDisclosureDeps(s);
    // Acknowledging the one published localization must NOT clear a gate whose
    // policy also demands German — that text does not exist yet.
    expect(
      (
        await acknowledgeDisclosure(deps, {
          userId: USER,
          disclosureId: 'risk-general',
          version: 1,
        })
      ).ok,
    ).toBe(true);
    expect((await disclosureGate(deps, USER)).required).toBe(true);

    // Once counsel publishes the missing locale, the ack stands (a member
    // reads ONE language — the array is a publication requirement).
    await publish(s, 'de');
    expect((await disclosureGate(deps, USER)).required).toBe(false);
  });

  it('is informational only when NO required locale requires acknowledgment', async () => {
    const s = services();
    await regionRequiring(s, ['en', 'de']);
    await publish(s, 'en', false);
    await publish(s, 'de', false);
    expect((await disclosureGate(buildDisclosureDeps(s), USER)).required).toBe(false);
  });

  it('one ack-requiring locale makes the whole ref ack-requiring', async () => {
    const s = services();
    await regionRequiring(s, ['en', 'de']);
    await publish(s, 'en', false);
    await publish(s, 'de', true);
    const deps = buildDisclosureDeps(s);
    expect((await disclosureGate(deps, USER)).required).toBe(true);
    await acknowledgeDisclosure(deps, { userId: USER, disclosureId: 'risk-general', version: 1 });
    expect((await disclosureGate(deps, USER)).required).toBe(false);
  });
});
