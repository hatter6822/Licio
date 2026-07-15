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
import { appendPolicyAudit, verifyPolicyAuditChain } from '../compliance/audit.js';
import { addCaseNote, createCase, transitionCase } from '../compliance/cases.js';
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
import { getEventPipelineServices } from '../events/services.js';
import { isComplianceReviewer, isCounsel } from '../identity/rbac.js';
import { getIdentityServices } from '../identity/services.js';
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
        const previous = await services.policies.activeForRegion(
          policyInput.country_or_region,
          nowIso,
        );
        let inserted: Awaited<ReturnType<typeof services.policies.insert>>;
        try {
          inserted = await services.policies.insert({
            policyId,
            countryOrRegion: policyInput.country_or_region,
            effectiveAt: policyInput.effective_at,
            document: validated.policy,
            createdAt: nowIso,
          });
        } catch {
          return c.json(
            deny('duplicate_policy', 'A policy for this region and effective_at already exists.'),
            409,
          );
        }
        await appendPolicyAudit(
          { policyAudit: services.policyAudit, now: services.now, uuid: services.uuid },
          {
            policyId: inserted.policyId,
            countryOrRegion: policyInput.country_or_region,
            changeType: previous === null ? 'create' : 'update',
            changedByRef: services.opaqueRef(auth.userId),
            previousValue: previous?.document ?? null,
            newValue: validated.policy,
            reason,
            approvalRef: approval_ref ?? null,
          },
        );
        await getIdentityServices().audit.append({
          actorUserId: auth.userId,
          eventType: 'compliance_policy_change',
          context: {
            setting: policyInput.country_or_region,
            new_value: previous === null ? 'create' : 'update',
          },
        });
        // Hot reload: this instance immediately, siblings via the broadcaster.
        services.policyCache.invalidate(policyInput.country_or_region);
        await services.broadcaster.publish(policyInput.country_or_region);
        services.metrics.increment('compliance.policy.written');
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
        const record = await services.declarations.upsert({
          ...existing,
          status: body.decision === 'verify' ? 'verified' : 'pending',
          verificationLevel: body.decision === 'verify' ? 'reviewer_verified' : 'unverified',
          verifiedAt: body.decision === 'verify' ? nowIso : null,
          verifiedBy: body.decision === 'verify' ? auth.userId : null,
          updatedAt: nowIso,
        });
        await getIdentityServices().audit.append({
          actorUserId: auth.userId,
          eventType: 'region_declaration_change',
          context: { setting: body.decision, target: services.opaqueRef(userId) },
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
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const result = await createCase(buildCaseDeps(services), {
          subjectKind: body.subject_kind,
          subjectRef: body.user_id_or_room_id,
          triggerType: body.trigger_type,
          riskLevel: body.risk_level,
          note: body.note,
          partnerCaseRef: body.partner_case_ref ?? null,
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
      const open = await services.cases.listByStates(
        ['open', 'assigned', 'investigating', 'escalated'],
        200,
      );
      const fraudClass = open.filter((record) =>
        ['velocity', 'pattern', 'sanctions', 'fraud', 'scam'].includes(record.triggerType),
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
            // The flagged intent's queue row rides its subject's newest
            // fraud-class case when one exists (context for the reviewer).
            const related =
              intent.userId === null ? [] : await services.cases.listBySubject(intent.userId, 1);
            const record = related[0] ?? null;
            return {
              case:
                record !== null
                  ? caseToWire(record)
                  : caseToWire({
                      caseId: intent.paymentIntentId,
                      userIdOrRoomId: intent.userId,
                      subjectKind: 'user' as const,
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
        const problem = validateComplianceConfigValue(key, value);
        if (problem !== null) return c.json(deny('invalid_config_value', problem), 400);
        await services.configStore.set(`compliance.${key}`, { value });
        await services.reloadConfig();
        // WS-E.1.4: retention-override changes propagate to the events job
        // immediately (shorten-only; the job clamps with min).
        if (key === 'eventRetentionOverrides') {
          getEventPipelineServices().retention.overrides = buildEventRetentionOverrides(
            services.config,
          );
        }
        await getIdentityServices().audit.append({
          actorUserId: auth.userId,
          eventType: 'compliance_config_change',
          context: { setting: key },
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
            publishedAt: new Date(services.now()).toISOString(),
          });
        } catch {
          return c.json(
            deny('already_published', 'This disclosure version is already published (immutable).'),
            409,
          );
        }
        await getIdentityServices().audit.append({
          actorUserId: auth.userId,
          eventType: 'disclosure_change',
          context: { setting: body.disclosure_id, new_value: `v${body.version}:${body.region}` },
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
