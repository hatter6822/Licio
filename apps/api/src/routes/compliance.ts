// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N compliance routes (SPEC §17.10; docs/planning/15-compliance.md).
//
// Three authorization planes:
//   • USER surface (authMiddleware): availability, region declaration,
//     disclosures + acknowledgments — the self-service jurisdiction UX.
//   • COMPLIANCE surface (requireCompliance — role + active MFA, WS-N.2.1c-2):
//     jurisdiction-policy admin, cases + the review state machine, the fraud
//     queue, declaration verification, wallet-risk pins, runtime config.
//   • COUNSEL surface (requireCounsel): SAR/STR (READ included —
//     anti-tipping-off), lawful-access review/production, disclosure
//     publication, and policy-enablement approvals ride the create path.
//
// The privacy boundary (WS-N.2.2d) is structural here too: no response in
// this file can carry attention/reading/social data because no store it
// reads HAS such a field.
import { zValidator } from '@hono/zod-validator';
import {
  type CaseResolution,
  type CaseTriggerType,
  caseAssignRequestSchema,
  caseCreateRequestSchema,
  caseListResponseSchema,
  caseNoteRequestSchema,
  caseReasonRequestSchema,
  caseResolveRequestSchema,
  declarationVerifyRequestSchema,
  disclosureAcknowledgeRequestSchema,
  disclosureListResponseSchema,
  disclosureVersionSchema,
  type FinancialComplianceCase,
  featureAvailabilityResponseSchema,
  fraudQueueResponseSchema,
  intentReviewRequestSchema,
  lawfulAccessCreateRequestSchema,
  lawfulAccessListResponseSchema,
  lawfulAccessProduceRequestSchema,
  lawfulAccessRequestSchema,
  lawfulAccessReviewRequestSchema,
  policyCreateRequestSchema,
  policyListResponseSchema,
  regionCodeSchema,
  regionDeclarationRequestSchema,
  regionResolutionResponseSchema,
  sarCreateRequestSchema,
  sarFileRequestSchema,
  sarListResponseSchema,
  sarReportSchema,
  uuidSchema,
  validatePolicy,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  appendCaseAuditInTx,
  appendPolicyAuditInTx,
  runChainedUnit,
  verifyPolicyAuditChain,
} from '../compliance/audit.js';
import { addCaseNote, createCase, resolveCaseInTx, transitionCase } from '../compliance/cases.js';
import { validateComplianceConfigValue } from '../compliance/config.js';
import {
  acknowledgeDisclosure,
  disclosureGate,
  listDisclosuresForUser,
} from '../compliance/disclosures.js';
import {
  intakeLawfulAccessRequest,
  recordLawfulAccessProduction,
  reviewLawfulAccessRequest,
} from '../compliance/lawful-access.js';
import { buildEventRetentionOverrides } from '../compliance/retention.js';
import { approveSar, createSarDraft, fileSar } from '../compliance/sar.js';
import {
  buildCaseDeps,
  buildDisclosureDeps,
  type ComplianceServices,
  evaluateAvailabilityForUser,
  getComplianceServices,
  resolveRegionForUser,
} from '../compliance/services.js';
import type { ComplianceCaseRecord, RegionDeclarationRecord } from '../compliance/stores.js';
import { UniqueViolationError } from '../compliance/stores.js';
import { getEventPipelineServices } from '../events/services.js';
import { isComplianceReviewer, isCounsel } from '../identity/rbac.js';
import { getIdentityServices } from '../identity/services.js';
import type { ReviewSubject } from '../knomosis/ports.js';
import { rateLimit } from '../lib/rate-limit.js';
import {
  type AuthEnv,
  authMiddleware,
  requireAuth,
  requireCompliance,
  requireCounsel,
  requireVerifiedAccount,
} from '../middleware/auth.js';
import { getTreasuryServices, treasuryServicesConfigured } from '../treasury/services.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
const notFound = { error: { code: 'not_found', message: 'Resource not found' } };

/** The triggers the WS-N.2.2c fraud queue reviews (the rest are case-console
 *  work).  One definition: the queue's own listing and the related-case lookup
 *  a held payment rides must agree on what "fraud-class" means. */
const FRAUD_CLASS_TRIGGERS: ReadonlySet<CaseTriggerType> = new Set([
  'velocity',
  'pattern',
  'sanctions',
  'fraud',
  'scam',
]);

/** The `compliance.*` keys that ARE the counsel-approved retention schedule
 *  (WS-N.2.1d): how long compliance and legal records are kept, and which are
 *  anonymized rather than deleted.  Counsel-only — the rest of the runtime
 *  config is operational and open to the compliance role. */
const RETENTION_SCHEDULE_KEYS: ReadonlySet<string> = new Set([
  'retentionDaysByTrigger',
  'retentionAnonymizeTriggers',
  'retentionScheduleRef',
  'eventRetentionOverrides',
]);

/**
 * Did a write hit a UNIQUE constraint rather than a broken store?  The answers
 * are opposite — "it already exists, stop" (409) versus "the store failed, try
 * again" (503) — so the two must never be conflated: telling counsel a
 * disclosure is already published when the store merely failed leaves the
 * required disclosure absent and stops them retrying.
 *
 * Drizzle wraps the driver error, so the 23505 is walked out of the cause
 * chain; the in-memory adapters raise `UniqueViolationError` for the same
 * conditions.  (The chain's own collisions never reach here: `appendChained`
 * re-raises them as `ChainContentionError`, which `runChainedUnit` retries.)
 */
function isUniqueViolation(error: unknown): boolean {
  if (error instanceof UniqueViolationError) return true;
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    if ((cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause ?? null;
  }
  return false;
}

/** Status-typed error responder (the tgError house idiom). */
function failJson(
  c: { json: (body: unknown, status: never) => Response },
  result: { status: number; code: string; message: string },
): Response {
  return c.json(deny(result.code, result.message), result.status as never);
}

// ---------------------------------------------------------------------------
// Wire mappers.
// ---------------------------------------------------------------------------

function caseToWire(record: ComplianceCaseRecord): FinancialComplianceCase {
  return {
    case_id: record.caseId,
    user_id_or_room_id: record.userIdOrRoomId,
    subject_kind: record.subjectKind,
    trigger_type: record.triggerType,
    risk_level: record.riskLevel,
    partner_case_ref: record.partnerCaseRef,
    review_state: record.reviewState,
    assigned_to: record.assignedTo,
    resolution: record.resolution,
    retention_policy: record.retentionPolicy,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function declarationToWire(record: RegionDeclarationRecord): {
  declared_region: string;
  status: RegionDeclarationRecord['status'];
  verification_level: RegionDeclarationRecord['verificationLevel'];
  verified_at: string | null;
  created_at: string;
} {
  return {
    declared_region: record.declaredRegion,
    status: record.status,
    verification_level: record.verificationLevel,
    verified_at: record.verifiedAt,
    created_at: record.createdAt,
  };
}

function availabilityToWire(
  availability: Awaited<ReturnType<typeof evaluateAvailabilityForUser>>,
): z.infer<typeof featureAvailabilityResponseSchema> {
  const features = Object.fromEntries(
    Object.entries(availability.features).map(([cell, entry]) => [
      cell,
      { state: entry.state, available: entry.available, disable_reason: entry.disableReason },
    ]),
  ) as z.infer<typeof featureAvailabilityResponseSchema>['features'];
  return featureAvailabilityResponseSchema.parse({
    region: availability.region,
    basis: availability.basis,
    policy_id: availability.policyId,
    crypto_enabled: availability.cryptoEnabled,
    governance_enabled: availability.governanceEnabled,
    features,
    assets: availability.assets,
    evaluated_at: new Date(getComplianceServices().now()).toISOString(),
  });
}

/** SLA due time for a queue row (config `slaHoursByRisk`, WS-N.2.2c). */
function slaDueAt(services: ComplianceServices, record: ComplianceCaseRecord): string {
  const hours = services.config().slaHoursByRisk[record.riskLevel] ?? 24;
  return new Date(Date.parse(record.createdAt) + hours * 3_600_000).toISOString();
}

/** The decided case could not be closed (a racing transition moved it, or its
 *  state has no sanctioned route).  Not a store fault: it aborts the unit so the
 *  decision entry cannot outlive the resolution it claims. */
class DecisionNotClosedError extends Error {
  constructor(caseId: string) {
    super(`case ${caseId} could not be resolved by the fraud-queue decision`);
    this.name = 'DecisionNotClosedError';
  }
}

/**
 * Put a fraud-queue decision's state change back when the decision could not be
 * recorded.  The ONE compensator this module keeps (the intent's compliance
 * column is the WS-M treasury's, a different bounded context — see
 * `recordIntentReviewDecision`), so its failure has nowhere to hide: a revert
 * that throws, or matches zero rows because the state moved again, leaves the
 * intent `cleared`/`blocked` with NO durable decision record while the route
 * reports the decision was not applied.  Nothing else will notice, so it alerts
 * — this is the repair signal, and the discrepancy is named in it.
 */
async function revertIntentState(
  services: ComplianceServices,
  paymentIntentId: string,
  from: 'cleared' | 'blocked',
  to: 'flagged',
): Promise<void> {
  try {
    const reverted = await getTreasuryServices().intents.updateComplianceState(
      paymentIntentId,
      from,
      to,
      new Date(services.now()).toISOString(),
    );
    if (reverted !== null) return;
  } catch (error) {
    services.alert('compliance.fraud_queue.revert_failed', {
      paymentIntentId,
      from,
      message: error instanceof Error ? error.message : 'unknown',
    });
    services.metrics.increment('compliance.fraud_queue.revert_failed');
    return;
  }
  services.alert('compliance.fraud_queue.revert_missed', {
    paymentIntentId,
    from,
    reason: 'the intent was no longer in the state the decision moved it to',
  });
  services.metrics.increment('compliance.fraud_queue.revert_failed');
}

/** A flagged intent, as much of it as the queue needs to find its review. */
interface HeldIntent {
  paymentIntentId: string;
  userId: string | null;
  roomId: string;
  targetType: string;
  amount: string;
}

/**
 * Who this intent's review is about — the same rule `reviewSubjectFor` applies
 * on the seam, read off the intent's own ownership.  A room-owned payout
 * belongs to the treasury, not to whichever steward authorized it, so the queue
 * can find its review knowing only the intent (it never learns the steward).
 */
const intentReviewSubject = (intent: HeldIntent): ReviewSubject =>
  intent.userId !== null
    ? { kind: 'user', ref: intent.userId }
    : { kind: 'room', ref: intent.roomId };

/**
 * THIS intent's review case.  Keyed by the intent, never by its owner: a user
 * can have two flagged intents at once, and a subject-wide "newest fraud case"
 * would show one intent's row against the other's review — then a release
 * would clear funds for one intent while appending the decision to the other's
 * chain, leaving the first unaudited.  One rule, shared by the queue's rows and
 * the decision record.
 */
async function relatedFraudCase(
  services: ComplianceServices,
  intent: HeldIntent,
): Promise<ComplianceCaseRecord | null> {
  const subject = intentReviewSubject(intent);
  // The high-value review `risk.ts` opens for this exact intent (its
  // `reviewRef` IS the intent id, and the key carries no action type — that is
  // what lets the intent leg and the WS-L leg share ONE review), then the case
  // this queue opened for it.
  const keys = [
    `highvalue:${subject.kind}:${subject.ref}:${intent.amount}:${intent.paymentIntentId}`,
    `intent-review:${intent.paymentIntentId}`,
  ];
  for (const key of keys) {
    const found = await services.cases.findByIdempotencyKey(key);
    if (found !== null && FRAUD_CLASS_TRIGGERS.has(found.triggerType)) return found;
  }
  return null;
}

/**
 * Durably record a fraud-queue decision on the per-case hash chain
 * (WS-N.2.2c).  This decision directly allows or prevents fund movement, so a
 * process log line is not enough: a later dispute or regulator needs an
 * append-only record of WHO cleared/blocked the payment and WHY.  With no
 * fraud-class case open, one is created keyed to the intent so the decision
 * always lands on a chain.  Returns false when it could not be recorded — the
 * caller then reverts its state change rather than move funds unaudited.
 *
 * THE ONE COMPENSATOR LEFT, and deliberately so.  Every other pairing in this
 * module is a `ComplianceTransactor` unit, because both halves live in the
 * `compliance` schema.  This pairing does not: the intent's compliance state
 * belongs to the WS-M treasury (the `knomosis` schema, its own store, its own
 * bounded context).  A transaction spanning them would have to hand the
 * compliance transactor a treasury store — coupling two contexts the WS-D.3.2
 * isolation proof deliberately keeps apart, to buy atomicity across a boundary
 * that exists for a stronger reason.  So the pair stays compensated, and the
 * revert is narrow: one CAS back to `flagged`, the state it came from.
 */
async function recordIntentReviewDecision(
  services: ComplianceServices,
  input: {
    intent: HeldIntent;
    decision: 'release' | 'reject';
    reason: string;
    actorUserId: string;
  },
): Promise<boolean> {
  try {
    let record = await relatedFraudCase(services, input.intent);
    if (record === null) {
      const subject = intentReviewSubject(input.intent);
      const opened = await createCase(buildCaseDeps(services), {
        // The intent's own subject — never the payment id as a stand-in "user",
        // which would file a room's payout in the user queue and the erasure
        // scrub under an id that is not a user's.
        subjectKind: subject.kind,
        subjectRef: subject.ref,
        triggerType: 'pattern',
        riskLevel: 'medium',
        note: `Payment intent ${input.intent.paymentIntentId} held for fraud review.`,
        idempotencyKey: `intent-review:${input.intent.paymentIntentId}`,
      });
      if (!opened.ok) return false;
      record = opened.record;
    }
    // The decision entry AND the resolution it records are one unit.  The
    // decision must close the review, for two reasons: an open case sits in the
    // queue forever (a queue that never drains), and `risk.ts` reads the CASE —
    // not the intent's column — to decide whether a high-value transfer has
    // been cleared, so a still-open review would meet the released deposit
    // again at the WS-L leg and block it a second time.  Recording "released"
    // while the review stayed open would be a chain entry that lies.
    const deps = buildCaseDeps(services);
    const closed = record;
    return await runChainedUnit(
      services.transactor,
      async (stores) => {
        await appendCaseAuditInTx(stores, deps, {
          caseId: closed.caseId,
          action: input.decision === 'release' ? 'fraud_queue_released' : 'fraud_queue_rejected',
          actorRef: services.opaqueRef(input.actorUserId),
          beforeState: closed.reviewState,
          afterState: 'resolved',
          note: `Payment intent ${input.intent.paymentIntentId} ${
            input.decision === 'release' ? 'released' : 'rejected'
          }: ${input.reason}`,
        });
        // A closure the state machine refuses (a reviewer moved the case under
        // us) must take the entry with it: returning `false` here would COMMIT
        // a `fraud_queue_released` entry for a review that stayed open while
        // the route reverted the intent — a chain that records a release which
        // never took effect.  Throwing abandons the unit whole.
        if (
          !(await resolveCaseInTx(stores, deps, {
            caseId: closed.caseId,
            actorUserId: input.actorUserId,
            resolution: {
              outcome: input.decision === 'release' ? 'cleared' : 'restricted',
              notes: `Fraud-queue ${input.decision}: ${input.reason}`,
              resolved_by: input.actorUserId,
              resolved_at: new Date(services.now()).toISOString(),
            },
          }))
        ) {
          throw new DecisionNotClosedError(closed.caseId);
        }
        return true;
      },
      'fraud-queue decision',
    );
  } catch {
    return false;
  }
}

// Identity-free write budgets (§19.1: per-endpoint global budgets, never IP).
const declarationBudget = rateLimit({ windowMs: 60_000, limit: 60 });
const policyWriteBudget = rateLimit({ windowMs: 60_000, limit: 30 });

// Return type INFERRED (never annotated as bare Hono<AuthEnv>): the chained
// route types must flow into AppType so the web RPC client stays typed.
export function createComplianceRoutes() {
  const app = new Hono<AuthEnv>()
    // -----------------------------------------------------------------------
    // USER surface.
    // -----------------------------------------------------------------------
    .get('/availability', authMiddleware(), async (c) => {
      const auth = requireAuth(c);
      const availability = await evaluateAvailabilityForUser(getComplianceServices(), auth.userId);
      return c.json(availabilityToWire(availability));
    })

    .get('/region', authMiddleware(), async (c) => {
      const auth = requireAuth(c);
      const services = getComplianceServices();
      const resolution = await resolveRegionForUser(services, auth.userId);
      const declaration = await services.declarations.get(auth.userId);
      return c.json(
        regionResolutionResponseSchema.parse({
          region: resolution.region,
          basis: resolution.basis,
          declaration: declaration === null ? null : declarationToWire(declaration),
        }),
      );
    })

    // WS-N.1.1f — declare a region (the PRIMARY basis; unverified until a
    // compliance reviewer verifies the referenced evidence — fail-closed).
    .post(
      '/region/declaration',
      declarationBudget,
      authMiddleware(),
      requireVerifiedAccount(),
      zValidator('json', regionDeclarationRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const nowIso = new Date(services.now()).toISOString();
        const existing = await services.declarations.get(auth.userId);
        const record = await services.declarations.upsert({
          userId: auth.userId,
          declaredRegion: body.declared_region,
          status: 'pending',
          verificationLevel: 'unverified',
          evidenceRef: body.evidence_ref ?? null,
          verifiedAt: null,
          verifiedBy: null,
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
        });
        // Unconditional (the member is declaring their OWN region — there is no
        // decision-about-a-prior-row to lose), so a null is a store fault.
        if (record === null) {
          return c.json(deny('unavailable', 'The declaration could not be stored.'), 503);
        }
        await getIdentityServices().audit.append({
          actorUserId: auth.userId,
          eventType: 'region_declaration_change',
          context: { setting: 'declare', new_value: body.declared_region },
        });
        services.metrics.increment('compliance.declaration.created');
        return c.json({ declaration: declarationToWire(record) }, 201);
      },
    )

    // Revocation reverts resolution to the locale subtag or unknown.
    .delete('/region/declaration', authMiddleware(), async (c) => {
      const auth = requireAuth(c);
      const services = getComplianceServices();
      const existing = await services.declarations.get(auth.userId);
      if (existing === null) return c.json(notFound, 404);
      await services.declarations.upsert({
        ...existing,
        status: 'revoked',
        verificationLevel: 'unverified',
        verifiedAt: null,
        verifiedBy: null,
        updatedAt: new Date(services.now()).toISOString(),
      });
      await getIdentityServices().audit.append({
        actorUserId: auth.userId,
        eventType: 'region_declaration_change',
        context: { setting: 'revoke' },
      });
      return c.json({ revoked: true });
    })

    .get('/disclosures', authMiddleware(), async (c) => {
      const auth = requireAuth(c);
      const services = getComplianceServices();
      const disclosures = await listDisclosuresForUser(buildDisclosureDeps(services), auth.userId);
      return c.json(
        disclosureListResponseSchema.parse({
          disclosures: disclosures.map((d) => ({
            disclosure_id: d.disclosureId,
            region: d.region,
            version: d.version,
            locale: d.locale,
            title: d.title,
            content_md: d.contentMd,
            requires_acknowledgment: d.requiresAcknowledgment,
            published_at: d.publishedAt,
            acknowledged: d.acknowledged,
          })),
        }),
      );
    })

    .post(
      '/disclosures/acknowledge',
      authMiddleware(),
      requireVerifiedAccount(),
      zValidator('json', disclosureAcknowledgeRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const result = await acknowledgeDisclosure(buildDisclosureDeps(services), {
          userId: auth.userId,
          disclosureId: body.disclosure_id,
          version: body.version,
        });
        if (!result.ok) return failJson(c, result);
        const gate = await disclosureGate(buildDisclosureDeps(services), auth.userId);
        return c.json({ acknowledged: true, remaining: gate.missing });
      },
    )

    // -----------------------------------------------------------------------
    // COMPLIANCE surface (WS-N.2.1c-2 role + active MFA).
    // -----------------------------------------------------------------------
    .get(
      '/admin/policies',
      authMiddleware(),
      requireCompliance(),
      zValidator('query', z.object({ region: regionCodeSchema.optional() })),
      async (c) => {
        const services = getComplianceServices();
        const { region } = c.req.valid('query');
        const rows =
          region === undefined
            ? await services.policies.listAll()
            : await services.policies.listByRegion(region);
        // Nonconforming stored rows are visible here (the linter surface) but
        // clearly marked — the engine treats them as absent.
        const policies: unknown[] = [];
        const nonconforming: Array<{ policy_id: string; problems: string[] }> = [];
        for (const row of rows) {
          const validated = validatePolicy(row.document);
          if (validated.ok) policies.push(validated.policy);
          else {
            nonconforming.push({
              policy_id: row.policyId,
              problems: validated.problems.map((p) => `${p.path}: ${p.problem}`),
            });
          }
        }
        return c.json({
          ...policyListResponseSchema.parse({ policies }),
          nonconforming,
        });
      },
    )

    // WS-N.1.1e — the audited policy write.  Enabling any cell requires the
    // counsel four-eyes `approval_ref` IN ADDITION to the validatePolicy
    // legal_approval_ref invariant (enabling is the dangerous direction).
    .post(
      '/admin/policies',
      policyWriteBudget,
      authMiddleware(),
      requireCompliance(),
      zValidator('json', policyCreateRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const { reason, approval_ref, ...policyInput } = body;
        const enablesCell = Object.values(policyInput.feature_flags).includes('enabled');
        // Enabling a cell turns real funds on for a whole region, so it takes
        // the COUNSEL capability — not merely a compliance reviewer quoting an
        // approval reference at themselves.  The reference records WHICH legal
        // approval authorizes it (validatePolicy also ties `enabled` to a
        // recorded `legal_approval_ref`); the session proves counsel actually
        // made the change.  Non-enabling writes (disabled/testnet/simulated/
        // pending-legal) stay open to the compliance role — they can only
        // narrow availability.
        if (enablesCell && !isCounsel(auth.roles)) {
          return c.json(
            deny(
              'counsel_approval_required',
              'Enabling a feature cell requires legal counsel (the compliance role may only narrow availability).',
            ),
            403,
          );
        }
        if (enablesCell && approval_ref === undefined) {
          return c.json(
            deny(
              'counsel_approval_required',
              'Enabling a feature cell requires a counsel approval reference (four-eyes).',
            ),
            403,
          );
        }
        const policyId = services.uuid();
        const candidate = { ...policyInput, policy_id: policyId };
        const validated = validatePolicy(candidate);
        if (!validated.ok) {
          return c.json(
            {
              error: deny('invalid_policy', 'Policy validation failed').error,
              problems: validated.problems,
            },
            400,
          );
        }
        const nowIso = new Date(services.now()).toISOString();
        // The policy row and its chain entry are ONE unit: a live policy the
        // chain never recorded is unauditable, and a chain entry for a policy
        // that failed to insert is a lie.  The unit also frees the operator's
        // retry — a rolled-back attempt leaves the (region, effective_at) slot
        // open rather than colliding with a half-written change.
        let previous: Awaited<ReturnType<typeof services.policies.activeForRegion>> = null;
        try {
          await runChainedUnit(
            services.transactor,
            async (stores) => {
              previous = await stores.policies.activeForRegion(
                policyInput.country_or_region,
                nowIso,
              );
              const inserted = await stores.policies.insert({
                policyId,
                countryOrRegion: policyInput.country_or_region,
                effectiveAt: policyInput.effective_at,
                document: validated.policy,
                createdAt: nowIso,
              });
              await appendPolicyAuditInTx(stores, services, {
                policyId: inserted.policyId,
                countryOrRegion: policyInput.country_or_region,
                changeType: previous === null ? 'create' : 'update',
                changedByRef: services.opaqueRef(auth.userId),
                previousValue: previous === null ? null : previous.document,
                newValue: validated.policy,
                reason,
                approvalRef: approval_ref ?? null,
              });
            },
            'jurisdiction policy write',
          );
        } catch (error) {
          // The `(region, effective_at)` unique is the only expected failure
          // here; anything else (an audit-store outage) rolled the whole unit
          // back, so nothing went live.
          if (isUniqueViolation(error)) {
            return c.json(
              deny('duplicate_policy', 'A policy for this region and effective_at already exists.'),
              409,
            );
          }
          services.metrics.increment('compliance.policy.write_failed');
          services.alert('compliance.policy.write_failed', {
            region: policyInput.country_or_region,
            message: error instanceof Error ? error.message : 'unknown',
          });
          return c.json(
            deny('audit_unavailable', 'The policy change was not applied and nothing was kept.'),
            503,
          );
        }
        // Hot reload FIRST: the policy is live and hash-audited from here on,
        // so serving a stale cached verdict until the TTL would be the real
        // harm.  (The identity audit below is a secondary index over the
        // authoritative chain entry just written — it must not be able to
        // strand an applied change behind an un-invalidated cache.)
        services.policyCache.invalidate(policyInput.country_or_region);
        try {
          await services.broadcaster.publish(policyInput.country_or_region);
        } catch (error) {
          // The policy is COMMITTED; it cannot be rolled back from here.  A
          // pub/sub outage means other instances serve the stale cached policy
          // until their TTL — worth an alert, not a 503: reporting failure for
          // an applied change sends the operator into a retry that can only
          // collide with the row now in place, and leaves them believing the
          // policy is not live when it is.  This instance already invalidated.
          services.metrics.increment('compliance.policy.invalidate_failed');
          services.alert('compliance.policy.invalidate_failed', {
            region: policyInput.country_or_region,
            message: error instanceof Error ? error.message : 'unknown',
            impact: 'other instances may serve the previous policy until their cache TTL lapses',
          });
        }
        services.metrics.increment('compliance.policy.written');
        // Best-effort: a transient identity-audit outage cannot un-apply a
        // committed, chained policy, and returning 500 would send the operator
        // into a retry that collides with the existing row for nothing.
        try {
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'compliance_policy_change',
            context: {
              setting: policyInput.country_or_region,
              new_value: previous === null ? 'create' : 'update',
            },
          });
        } catch (error) {
          services.alert('compliance.policy.identity_audit_failed', {
            region: policyInput.country_or_region,
            message: error instanceof Error ? error.message : 'unknown',
          });
        }
        return c.json({ policy: validated.policy }, 201);
      },
    )

    // Emergency force-refresh: cross-instance cache invalidation NOW.
    .post('/admin/policies/refresh', authMiddleware(), requireCompliance(), async (c) => {
      const auth = requireAuth(c);
      const services = getComplianceServices();
      services.policyCache.invalidate(null);
      await services.broadcaster.publish(null);
      await getIdentityServices().audit.append({
        actorUserId: auth.userId,
        eventType: 'compliance_policy_change',
        context: { setting: 'force_refresh' },
      });
      return c.json({ refreshed: true });
    })

    .get('/admin/policy-audit/verify', authMiddleware(), requireCompliance(), async (c) => {
      const services = getComplianceServices();
      const verification = await verifyPolicyAuditChain({ policyAudit: services.policyAudit });
      return c.json(verification);
    })

    // WS-N.1.1f — verify/reject a pending declaration after evidence review.
    .post(
      '/admin/declarations/:userId/verify',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ userId: uuidSchema })),
      zValidator('json', declarationVerifyRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const { userId } = c.req.valid('param');
        const body = c.req.valid('json');
        const existing = await services.declarations.get(userId);
        if (existing === null || existing.status === 'revoked') return c.json(notFound, 404);
        const nowIso = new Date(services.now()).toISOString();
        const record = await services.declarations.upsert(
          {
            ...existing,
            status: body.decision === 'verify' ? 'verified' : 'pending',
            verificationLevel: body.decision === 'verify' ? 'reviewer_verified' : 'unverified',
            verifiedAt: body.decision === 'verify' ? nowIso : null,
            verifiedBy: body.decision === 'verify' ? auth.userId : null,
            updatedAt: nowIso,
          },
          // CAS on the PREMISES this decision was made about.  A member who
          // revoked or re-declared since it was read keeps their change: a
          // verified declaration is the real-funds region basis, so
          // resurrecting a revoked one — or verifying evidence against a region
          // the member has left — is exactly what must not happen.
          {
            declaredRegion: existing.declaredRegion,
            status: existing.status,
            updatedAt: existing.updatedAt,
          },
        );
        if (record === null) {
          return c.json(
            deny(
              'declaration_changed',
              'The declaration changed while under review; re-read it and decide again.',
            ),
            409,
          );
        }
        await getIdentityServices().audit.append({
          actorUserId: auth.userId,
          eventType: 'region_declaration_change',
          // The subject rides `targetRef`, NOT the context: `redactContext`
          // keeps a closed allowlist (device/auth_method/setting/
          // previous_value/new_value/reason) and drops anything else, so a
          // `target` key here would vanish and the entry would record that a
          // reviewer verified *something*.  This verification is the only
          // anti-circumvention control the region ladder has (§19.1 leaves no
          // detected baseline to cross-check), so its subject must persist.
          targetRef: services.opaqueRef(userId),
          context: { setting: body.decision, reason: body.note },
        });
        return c.json({ declaration: declarationToWire(record) });
      },
    )

    // ------------------------------ Cases ----------------------------------
    .get(
      '/admin/cases',
      authMiddleware(),
      requireCompliance(),
      zValidator(
        'query',
        z.object({
          state: z.enum(['open', 'assigned', 'investigating', 'resolved', 'escalated']).optional(),
        }),
      ),
      async (c) => {
        const services = getComplianceServices();
        const { state } = c.req.valid('query');
        const states =
          state === undefined
            ? (['open', 'assigned', 'investigating', 'escalated'] as const)
            : ([state] as const);
        const records = await services.cases.listByStates(states, 200);
        return c.json(caseListResponseSchema.parse({ cases: records.map(caseToWire) }));
      },
    )

    .post(
      '/admin/cases',
      authMiddleware(),
      requireCompliance(),
      zValidator('json', caseCreateRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const result = await createCase(buildCaseDeps(services), {
          subjectKind: body.subject_kind,
          subjectRef: body.user_id_or_room_id,
          triggerType: body.trigger_type,
          riskLevel: body.risk_level,
          note: body.note,
          partnerCaseRef: body.partner_case_ref ?? null,
          // A console-opened case names the reviewer who opened it; without
          // this its genesis entry would read `system` and be
          // indistinguishable from one the engine raised.
          actorUserId: auth.userId,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ case: caseToWire(result.record) }, 201);
      },
    )

    .get(
      '/admin/cases/:caseId',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ caseId: uuidSchema })),
      async (c) => {
        const services = getComplianceServices();
        const { caseId } = c.req.valid('param');
        const record = await services.cases.getById(caseId);
        if (record === null) return c.json(notFound, 404);
        const trail = await services.caseAudit.listChained(caseId);
        return c.json({
          case: caseToWire(record),
          audit: trail.map((entry) => ({
            action: entry.action,
            actor_ref: entry.actorRef,
            before_state: entry.beforeState,
            after_state: entry.afterState,
            note: entry.note,
            created_at: entry.createdAt,
          })),
        });
      },
    )

    .post(
      '/admin/cases/:caseId/assign',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ caseId: uuidSchema })),
      zValidator('json', caseAssignRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const { caseId } = c.req.valid('param');
        const { assignee_user_id } = c.req.valid('json');
        // Assignment only to a compliance-capable reviewer (WS-N.2.1c).
        const assignee = await getIdentityServices().store.getUser(assignee_user_id);
        if (assignee === null || !isComplianceReviewer(assignee.roles)) {
          return c.json(
            deny('assignee_not_reviewer', 'The assignee must hold the compliance role.'),
            400,
          );
        }
        const result = await transitionCase(buildCaseDeps(services), {
          caseId,
          to: 'assigned',
          actorUserId: auth.userId,
          isSenior: isCounsel(auth.roles),
          assigneeUserId: assignee_user_id,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ case: caseToWire(result.record) });
      },
    )

    .post(
      '/admin/cases/:caseId/begin',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ caseId: uuidSchema })),
      async (c) => {
        const auth = requireAuth(c);
        const result = await transitionCase(buildCaseDeps(getComplianceServices()), {
          caseId: c.req.valid('param').caseId,
          to: 'investigating',
          actorUserId: auth.userId,
          isSenior: isCounsel(auth.roles),
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ case: caseToWire(result.record) });
      },
    )

    .post(
      '/admin/cases/:caseId/resolve',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ caseId: uuidSchema })),
      zValidator('json', caseResolveRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const resolution: CaseResolution = {
          outcome: body.outcome,
          notes: body.notes,
          resolved_by: auth.userId,
          resolved_at: new Date(services.now()).toISOString(),
        };
        const result = await transitionCase(buildCaseDeps(services), {
          caseId: c.req.valid('param').caseId,
          to: 'resolved',
          actorUserId: auth.userId,
          isSenior: isCounsel(auth.roles),
          resolution,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ case: caseToWire(result.record) });
      },
    )

    .post(
      '/admin/cases/:caseId/escalate',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ caseId: uuidSchema })),
      zValidator('json', caseReasonRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const result = await transitionCase(buildCaseDeps(getComplianceServices()), {
          caseId: c.req.valid('param').caseId,
          to: 'escalated',
          actorUserId: auth.userId,
          isSenior: isCounsel(auth.roles),
          reason: c.req.valid('json').reason,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ case: caseToWire(result.record) });
      },
    )

    .post(
      '/admin/cases/:caseId/reopen',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ caseId: uuidSchema })),
      zValidator('json', caseReasonRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const result = await transitionCase(buildCaseDeps(getComplianceServices()), {
          caseId: c.req.valid('param').caseId,
          to: 'investigating',
          actorUserId: auth.userId,
          isSenior: isCounsel(auth.roles),
          reason: c.req.valid('json').reason,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ case: caseToWire(result.record) });
      },
    )

    .post(
      '/admin/cases/:caseId/note',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ caseId: uuidSchema })),
      zValidator('json', caseNoteRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const result = await addCaseNote(buildCaseDeps(getComplianceServices()), {
          caseId: c.req.valid('param').caseId,
          actorUserId: auth.userId,
          note: c.req.valid('json').note,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ case: caseToWire(result.record) });
      },
    )

    // ------------------------- The fraud queue (WS-N.2.2c) ------------------
    .get('/admin/fraud-queue', authMiddleware(), requireCompliance(), async (c) => {
      const services = getComplianceServices();
      // Filtered IN THE QUERY, so the cap bounds fraud-class cases.  Capping
      // first and filtering after spent the page on unrelated triggers: with
      // >200 open cases, fraud/velocity/sanctions cases outside that page had
      // no queue row, no SLA, and no review action until enough unrelated cases
      // closed.
      const fraudClass = await services.cases.listByStatesAndTriggers(
        ['open', 'assigned', 'investigating', 'escalated'],
        [...FRAUD_CLASS_TRIGGERS],
        200,
      );
      const flagged = treasuryServicesConfigured()
        ? await getTreasuryServices().intents.listByComplianceState('flagged', 200)
        : [];
      const items = [
        ...fraudClass.map((record) => ({
          case: caseToWire(record),
          payment_intent_id: null,
          payment_compliance_state: null,
          sla_due_at: slaDueAt(services, record),
        })),
        ...(await Promise.all(
          flagged.map(async (intent) => {
            // The flagged intent's queue row rides the subject's newest OPEN
            // FRAUD-CLASS case (the review this hold is about) — the same rule
            // the decision record uses.  An unfiltered "newest case" would
            // happily attach an unrelated resolved or non-fraud case and show
            // the reviewer the wrong trigger, risk, and SLA for the held
            // payment; with no such case the synthetic row below describes the
            // intent itself.
            const held: HeldIntent = {
              paymentIntentId: intent.paymentIntentId,
              userId: intent.userId,
              roomId: intent.roomId,
              targetType: intent.targetType,
              amount: intent.amount,
            };
            const record = await relatedFraudCase(services, held);
            return {
              case:
                record !== null
                  ? caseToWire(record)
                  : caseToWire({
                      caseId: intent.paymentIntentId,
                      userIdOrRoomId: intentReviewSubject({
                        paymentIntentId: intent.paymentIntentId,
                        userId: intent.userId,
                        roomId: intent.roomId,
                        targetType: intent.targetType,
                        amount: intent.amount,
                      }).ref,
                      subjectKind: intentReviewSubject({
                        paymentIntentId: intent.paymentIntentId,
                        userId: intent.userId,
                        roomId: intent.roomId,
                        targetType: intent.targetType,
                        amount: intent.amount,
                      }).kind,
                      triggerType: 'pattern' as const,
                      riskLevel: 'medium' as const,
                      partnerCaseRef: null,
                      reviewState: 'open' as const,
                      assignedTo: null,
                      resolution: null,
                      retentionPolicy: {
                        retention_period_days: 730,
                        deletion_date: new Date(services.now() + 730 * 86_400_000).toISOString(),
                        legal_hold: false,
                        legal_hold_refs: [],
                      },
                      idempotencyKey: null,
                      createdAt: intent.createdAt,
                      updatedAt: intent.updatedAt,
                    }),
              payment_intent_id: intent.paymentIntentId,
              payment_compliance_state: intent.complianceState,
              sla_due_at: new Date(
                Date.parse(intent.createdAt) +
                  (services.config().slaHoursByRisk['medium'] ?? 4) * 3_600_000,
              ).toISOString(),
            };
          }),
        )),
      ];
      return c.json(fraudQueueResponseSchema.parse({ items }));
    })

    // Release: flagged → cleared; the intent may proceed (WS-N.2.2c).
    .post(
      '/admin/fraud-queue/release',
      authMiddleware(),
      requireCompliance(),
      zValidator('json', intentReviewRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        if (!treasuryServicesConfigured()) return c.json(notFound, 404);
        const body = c.req.valid('json');
        const updated = await getTreasuryServices().intents.updateComplianceState(
          body.payment_intent_id,
          'flagged',
          'cleared',
          new Date(services.now()).toISOString(),
        );
        if (updated === null) {
          return c.json(deny('not_flagged', 'The intent is not held for review.'), 409);
        }
        // The decision must be on the chain before the money can move: if it
        // cannot be recorded, the hold goes back on rather than release funds
        // with no durable account of who allowed it or why.
        const recorded = await recordIntentReviewDecision(services, {
          intent: {
            paymentIntentId: updated.paymentIntentId,
            userId: updated.userId,
            roomId: updated.roomId,
            targetType: updated.targetType,
            amount: updated.amount,
          },
          decision: 'release',
          reason: body.reason,
          actorUserId: auth.userId,
        });
        if (!recorded) {
          await revertIntentState(services, body.payment_intent_id, 'cleared', 'flagged');
          return c.json(
            deny('audit_unavailable', 'The release was not applied: it could not be recorded.'),
            503,
          );
        }
        services.log('compliance.fraud_queue.released', {
          paymentIntentId: body.payment_intent_id,
          actorRef: services.opaqueRef(auth.userId),
        });
        return c.json({
          payment_intent_id: updated.paymentIntentId,
          compliance_state: updated.complianceState,
        });
      },
    )

    // Reject: flagged → blocked; the intent can never advance (the expiry
    // sweep abandons it) and the user sees the block reason on read.
    .post(
      '/admin/fraud-queue/reject',
      authMiddleware(),
      requireCompliance(),
      zValidator('json', intentReviewRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        if (!treasuryServicesConfigured()) return c.json(notFound, 404);
        const body = c.req.valid('json');
        const updated = await getTreasuryServices().intents.updateComplianceState(
          body.payment_intent_id,
          'flagged',
          'blocked',
          new Date(services.now()).toISOString(),
        );
        if (updated === null) {
          return c.json(deny('not_flagged', 'The intent is not held for review.'), 409);
        }
        // A block is as consequential as a release — it stops a member's
        // funds — so it is recorded the same way, or reverted to `flagged`.
        const recorded = await recordIntentReviewDecision(services, {
          intent: {
            paymentIntentId: updated.paymentIntentId,
            userId: updated.userId,
            roomId: updated.roomId,
            targetType: updated.targetType,
            amount: updated.amount,
          },
          decision: 'reject',
          reason: body.reason,
          actorUserId: auth.userId,
        });
        if (!recorded) {
          await revertIntentState(services, body.payment_intent_id, 'blocked', 'flagged');
          return c.json(
            deny('audit_unavailable', 'The rejection was not applied: it could not be recorded.'),
            503,
          );
        }
        services.log('compliance.fraud_queue.rejected', {
          paymentIntentId: body.payment_intent_id,
          actorRef: services.opaqueRef(auth.userId),
        });
        return c.json({
          payment_intent_id: updated.paymentIntentId,
          compliance_state: updated.complianceState,
        });
      },
    )

    // -------------------- Wallet-risk pins (WS-N.2.2e/2.3b) -----------------
    .post(
      '/admin/wallets/:walletAccountId/pin',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ walletAccountId: uuidSchema })),
      zValidator('json', z.object({ reason: z.string().min(1).max(2000) }).strict()),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const { walletAccountId } = c.req.valid('param');
        const record = await services.pins.pin({
          id: services.uuid(),
          walletAccountId,
          reason: c.req.valid('json').reason,
          pinnedByRef: services.opaqueRef(auth.userId),
          createdAt: new Date(services.now()).toISOString(),
          releasedAt: null,
          releasedByRef: null,
        });
        services.metrics.increment('compliance.wallet_pin.created');
        return c.json({ pinned: true, created_at: record.createdAt }, 201);
      },
    )

    .delete(
      '/admin/wallets/:walletAccountId/pin',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ walletAccountId: uuidSchema })),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const released = await services.pins.release(
          c.req.valid('param').walletAccountId,
          services.opaqueRef(auth.userId),
          new Date(services.now()).toISOString(),
        );
        if (!released) return c.json(notFound, 404);
        return c.json({ released: true });
      },
    )

    // ----------------------- Runtime config (compliance.*) ------------------
    .put(
      '/admin/config/:key',
      authMiddleware(),
      requireCompliance(),
      zValidator('param', z.object({ key: z.string().min(1).max(64) })),
      zValidator('json', z.object({ value: z.unknown() })),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const { key } = c.req.valid('param');
        const { value } = c.req.valid('json');
        // The retention schedule is a COUNSEL artifact (WS-N.2.1d: "a
        // counsel-approved retention schedule"), and these keys are how long
        // compliance and legal records live.  A compliance reviewer may tune
        // the operational knobs; rewriting the schedule takes counsel.
        if (RETENTION_SCHEDULE_KEYS.has(key) && !isCounsel(auth.roles)) {
          return c.json(
            deny(
              'counsel_approval_required',
              'The retention schedule is counsel-approved; changing it requires legal counsel.',
            ),
            403,
          );
        }
        const problem = validateComplianceConfigValue(key, value);
        if (problem !== null) return c.json(deny('invalid_config_value', problem), 400);
        // WHO changed it rides the SAME write as the change.  These are the
        // counsel-approved retention schedule and the operational risk limits:
        // once the write lands the setting is live, reloaded, and possibly
        // already propagated to the events job, so an attribution recorded
        // afterwards and lost to a failure leaves a live compliance control
        // that no durable record accounts for.  The loader reads `value` and
        // nothing else, so the envelope carries this without touching it.
        await services.configStore.set(`compliance.${key}`, {
          value,
          changed_by_ref: services.opaqueRef(auth.userId),
          changed_at: new Date(services.now()).toISOString(),
        });
        await services.reloadConfig();
        // WS-E.1.4: retention-override changes propagate to the events job
        // immediately (shorten-only; the job clamps with min).
        if (key === 'eventRetentionOverrides') {
          getEventPipelineServices().retention.overrides = buildEventRetentionOverrides(
            services.config,
          );
        }
        // Best-effort MIRROR into the identity audit (a different bounded
        // context, so it cannot join the write above): failing it must not 500
        // a change that is already live and attributed.
        await getIdentityServices()
          .audit.append({
            actorUserId: auth.userId,
            eventType: 'compliance_config_change',
            context: { setting: key },
          })
          .catch((error: unknown) => {
            services.log('compliance.config.audit_mirror_failed', {
              key,
              message: error instanceof Error ? error.message : 'unknown',
            });
          });
        return c.json({ key, applied: true });
      },
    )

    // -----------------------------------------------------------------------
    // COUNSEL surface (WS-N.2.1e / WS-N.2.3d / WS-N.1.2d publication).
    // -----------------------------------------------------------------------
    .post(
      '/admin/cases/:caseId/sar',
      authMiddleware(),
      requireCounsel(),
      zValidator('param', z.object({ caseId: uuidSchema })),
      zValidator('json', sarCreateRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const result = await createSarDraft(
          {
            sars: services.sars,
            caseDeps: buildCaseDeps(services),
            opaqueRef: services.opaqueRef,
            now: services.now,
            uuid: services.uuid,
          },
          {
            caseId: c.req.valid('param').caseId,
            jurisdiction: body.jurisdiction,
            narrative: body.narrative,
            actorUserId: auth.userId,
          },
        );
        if (!result.ok) return failJson(c, result);
        return c.json({ report: sarReportToWire(result.record) }, 201);
      },
    )

    .get('/admin/sar', authMiddleware(), requireCounsel(), async (c) => {
      const services = getComplianceServices();
      const reports = await services.sars.list(200);
      return c.json(sarListResponseSchema.parse({ reports: reports.map(sarReportToWire) }));
    })

    .post(
      '/admin/sar/:sarId/approve',
      authMiddleware(),
      requireCounsel(),
      zValidator('param', z.object({ sarId: uuidSchema })),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const result = await approveSar(
          {
            sars: services.sars,
            caseDeps: buildCaseDeps(services),
            opaqueRef: services.opaqueRef,
            now: services.now,
            uuid: services.uuid,
          },
          { sarId: c.req.valid('param').sarId, actorUserId: auth.userId },
        );
        if (!result.ok) return failJson(c, result);
        return c.json({ report: sarReportToWire(result.record) });
      },
    )

    .post(
      '/admin/sar/:sarId/file',
      authMiddleware(),
      requireCounsel(),
      zValidator('param', z.object({ sarId: uuidSchema })),
      zValidator('json', sarFileRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const result = await fileSar(
          {
            sars: services.sars,
            caseDeps: buildCaseDeps(services),
            opaqueRef: services.opaqueRef,
            now: services.now,
            uuid: services.uuid,
          },
          {
            sarId: c.req.valid('param').sarId,
            filingRef: body.filing_ref,
            partnerFiled: body.partner_filed,
            actorUserId: auth.userId,
          },
        );
        if (!result.ok) return failJson(c, result);
        return c.json({ report: sarReportToWire(result.record) });
      },
    )

    .post(
      '/admin/lawful-access',
      authMiddleware(),
      requireCounsel(),
      zValidator('json', lawfulAccessCreateRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const result = await intakeLawfulAccessRequest(buildLawfulDeps(services), {
          agency: body.agency,
          jurisdiction: body.jurisdiction,
          legalBasis: body.legal_basis,
          scope: body.scope,
          contact: body.contact,
          actorUserId: auth.userId,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ request: lawfulToWire(result.record) }, 201);
      },
    )

    .get('/admin/lawful-access', authMiddleware(), requireCounsel(), async (c) => {
      const services = getComplianceServices();
      const requests = await services.lawfulAccess.list(null, 200);
      return c.json(lawfulAccessListResponseSchema.parse({ requests: requests.map(lawfulToWire) }));
    })

    .post(
      '/admin/lawful-access/:requestId/review',
      authMiddleware(),
      requireCounsel(),
      zValidator('param', z.object({ requestId: uuidSchema })),
      zValidator('json', lawfulAccessReviewRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const result = await reviewLawfulAccessRequest(buildLawfulDeps(services), {
          requestId: c.req.valid('param').requestId,
          decision: body.decision,
          note: body.note,
          actorUserId: auth.userId,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ request: lawfulToWire(result.record) });
      },
    )

    .post(
      '/admin/lawful-access/:requestId/produce',
      authMiddleware(),
      requireCounsel(),
      zValidator('param', z.object({ requestId: uuidSchema })),
      zValidator('json', lawfulAccessProduceRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const result = await recordLawfulAccessProduction(buildLawfulDeps(services), {
          requestId: c.req.valid('param').requestId,
          productionSummary: body.production_summary,
          userNotified: body.user_notified,
          actorUserId: auth.userId,
        });
        if (!result.ok) return failJson(c, result);
        return c.json({ request: lawfulToWire(result.record) });
      },
    )

    // WS-N.1.2d — publish a disclosure version (publish-immutable).
    .post(
      '/admin/disclosures',
      authMiddleware(),
      requireCounsel(),
      zValidator('json', disclosureVersionSchema.omit({ published_at: true }).strict()),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        let record: Awaited<ReturnType<typeof services.disclosures.publish>>;
        try {
          record = await services.disclosures.publish({
            id: services.uuid(),
            disclosureId: body.disclosure_id,
            region: body.region,
            version: body.version,
            locale: body.locale,
            title: body.title,
            contentMd: body.content_md,
            requiresAcknowledgment: body.requires_acknowledgment,
            // The attribution rides the row the publish creates, so the act and
            // the record of WHO performed it are ONE write.  Recorded after,
            // it could be lost to a failure and never recovered: a publish is
            // immutable, so the retry only meets `already_published` and the
            // live legal disclosure would keep no publisher record at all.
            publishedByRef: services.opaqueRef(auth.userId),
            publishedAt: new Date(services.now()).toISOString(),
          });
        } catch (error) {
          // ONLY the unique conflict is `already_published`.  Calling a store
          // outage that too would tell counsel the immutable version exists —
          // so they stop retrying, and the required risk disclosure stays
          // absent while the surfaces that demand it fail closed.
          if (isUniqueViolation(error)) {
            return c.json(
              deny(
                'already_published',
                'This disclosure version is already published (immutable).',
              ),
              409,
            );
          }
          services.metrics.increment('compliance.disclosure.publish_failed');
          services.alert('compliance.disclosure.publish_failed', {
            disclosureId: body.disclosure_id,
            message: error instanceof Error ? error.message : 'unknown',
          });
          return c.json(
            deny('unavailable', 'The disclosure could not be published; nothing was kept.'),
            503,
          );
        }
        // Best-effort NOTIFICATION, not the record of truth: the attribution
        // is already committed on the row above (the identity audit is a
        // different bounded context, so it cannot join that write), and a
        // 500 here would leave an immutable published disclosure the client
        // believes failed.
        await getIdentityServices()
          .audit.append({
            actorUserId: auth.userId,
            eventType: 'disclosure_change',
            context: { setting: body.disclosure_id, new_value: `v${body.version}:${body.region}` },
          })
          .catch((error: unknown) => {
            services.log('compliance.disclosure.audit_mirror_failed', {
              disclosureId: body.disclosure_id,
              message: error instanceof Error ? error.message : 'unknown',
            });
          });
        return c.json({ published_at: record.publishedAt }, 201);
      },
    );

  return app;
}

// ---------------------------------------------------------------------------
// Local helpers (wire mapping + deps assembly).
// ---------------------------------------------------------------------------

function sarReportToWire(record: {
  sarId: string;
  caseId: string;
  jurisdiction: string;
  status: 'draft' | 'approved' | 'filed';
  narrative: string;
  filingRef: string | null;
  filedAt: string | null;
  partnerFiled: boolean;
  createdAt: string;
}): z.infer<typeof sarReportSchema> {
  return sarReportSchema.parse({
    sar_id: record.sarId,
    case_id: record.caseId,
    jurisdiction: record.jurisdiction,
    status: record.status,
    narrative: record.narrative,
    filing_ref: record.filingRef,
    filed_at: record.filedAt,
    partner_filed: record.partnerFiled,
    created_at: record.createdAt,
  });
}

function lawfulToWire(record: {
  requestId: string;
  agency: string;
  jurisdiction: string;
  legalBasis: 'warrant' | 'subpoena' | 'court_order' | 'emergency';
  scope: {
    subject_kind: 'user' | 'room' | 'transaction';
    subject_ref: string;
    time_range_start: string | null;
    time_range_end: string | null;
  };
  contact: string;
  status: 'received' | 'under_review' | 'approved' | 'denied' | 'produced';
  productionSummary: string | null;
  userNotifiedAt: string | null;
  caseId: string | null;
  createdAt: string;
}): z.infer<typeof lawfulAccessRequestSchema> {
  return lawfulAccessRequestSchema.parse({
    request_id: record.requestId,
    agency: record.agency,
    jurisdiction: record.jurisdiction,
    legal_basis: record.legalBasis,
    scope: record.scope,
    contact: record.contact,
    status: record.status,
    production_summary: record.productionSummary,
    user_notified_at: record.userNotifiedAt,
    case_id: record.caseId,
    created_at: record.createdAt,
  });
}

function buildLawfulDeps(
  services: ComplianceServices,
): Parameters<typeof intakeLawfulAccessRequest>[0] {
  return {
    requests: services.lawfulAccess,
    caseDeps: buildCaseDeps(services),
    roomStorageMode: services.roomStorageMode,
    opaqueRef: services.opaqueRef,
    now: services.now,
    uuid: services.uuid,
  };
}
