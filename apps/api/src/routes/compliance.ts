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
  type JurisdictionFeaturePolicy,
  lawfulAccessCreateRequestSchema,
  lawfulAccessListResponseSchema,
  lawfulAccessProduceRequestSchema,
  lawfulAccessRequestSchema,
  lawfulAccessReviewRequestSchema,
  policyChangeRequiresCounsel,
  policyCreateRequestSchema,
  policyListResponseSchema,
  type ReviewSubject,
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
  mustApply,
  runChainedUnit,
  verifyPolicyAuditChain,
} from '../compliance/audit.js';
import {
  addCaseNote,
  announceCaseCreated,
  createCase,
  createCaseInTx,
  resolveCaseInTx,
  transitionCase,
} from '../compliance/cases.js';
import { validateComplianceConfigValue } from '../compliance/config.js';
import {
  acknowledgeDisclosure,
  disclosureGate,
  listDisclosuresForUser,
} from '../compliance/disclosures.js';
import {
  intakeLawfulAccessRequest,
  notifyLawfulAccessSubject,
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
import { isUniqueViolation } from '../lib/pg-errors.js';
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
import { TERMINAL_INTENT_STATES } from '../treasury/stores.js';

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

// `isUniqueViolation` (`lib/pg-errors.ts`) answers the question these writes
// must never get wrong: "it already exists, stop" (409) versus "the store
// failed, try again" (503) are opposite instructions, and telling counsel a
// disclosure is already published when the store merely failed leaves the
// required disclosure absent and stops them retrying.  (The chain's own
// collisions never reach it: `appendChained` re-raises them as
// `ChainContentionError`, which `runChainedUnit` retries.)

/** Thrown INSIDE the policy-write chained unit when the counsel delta
 *  (`policyChangeRequiresCounsel`) demands legal counsel — rolls the whole
 *  unit back (no policy row, no chain entry) and maps to a 403.  Deciding
 *  inside the unit, against the SAME prior-active read the audit entry
 *  records, closes the gate-then-write race a pre-transaction check leaves
 *  open (a concurrent narrowing landing between check and insert).
 *  `scheduling` is the timeline arm: a non-counsel write whose `effective_at`
 *  is in the future or behind the active row — without it, a reviewer could
 *  plant a byte-identical carry-forward of today's counsel-approved policy
 *  DATED AFTER a counsel-scheduled narrowing, and the "no-op" delta would
 *  silently re-expand availability when its date arrives. */
class CounselRequiredError extends Error {
  readonly missing: 'role' | 'approval_ref' | 'scheduling';
  constructor(missing: 'role' | 'approval_ref' | 'scheduling') {
    super('counsel approval required');
    this.name = 'CounselRequiredError';
    this.missing = missing;
  }
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
        mustApply(
          await resolveCaseInTx(stores, deps, {
            caseId: closed.caseId,
            actorUserId: input.actorUserId,
            resolution: {
              outcome: input.decision === 'release' ? 'cleared' : 'restricted',
              notes: `Fraud-queue ${input.decision}: ${input.reason}`,
              resolved_by: input.actorUserId,
              resolved_at: new Date(services.now()).toISOString(),
            },
          }),
          'fraud-queue decision',
        );
        return true;
      },
      'fraud-queue decision',
    );
  } catch {
    return false;
  }
}

// Identity-free write budgets (§19.1: per-endpoint global budgets, never IP).
//
// Mounted AFTER the auth/role gate, deliberately.  These budgets are GLOBAL —
// §19.1 leaves nothing to key them by — so whoever spends them spends them for
// everyone.  Ahead of the gate, an unauthenticated caller could exhaust the
// 30/min policy budget and 429 an emergency jurisdiction-policy change, or hold
// every member's region declaration at 60/min, without ever holding a session.
// A budget bounds the WORK an endpoint does, and a request that 401s does none.
// Connection-level flood fairness is the edge's concern (§19.1), not a
// consumable an anonymous caller gets to burn on counsel's behalf.
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
      authMiddleware(),
      requireVerifiedAccount(),
      declarationBudget,
      zValidator('json', regionDeclarationRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const nowIso = new Date(services.now()).toISOString();
        // READ → GUARD → CAS, retried.  A VERIFIED declaration is the real-funds
        // region basis AND the only anti-circumvention control the §19.1 ladder
        // has, so a redeclaration must NOT silently erase it (overwriting the
        // verified row with a fresh `pending` one drops `resolveRegion` to the
        // weaker locale rung — a verified-BLOCKED member could then reach the
        // routes that reject only an explicit `blocked`).  The guard alone is a
        // TOCTOU: a reviewer can verify the pending row BETWEEN our read and our
        // write, and an unconditional upsert would clobber `reviewer_verified`.
        // So the write CASes on the read premises; a miss RE-READS and re-checks
        // (the re-read now sees the verify and 409s) rather than clobbering it.
        // Changing a verified region stays an explicit, audited act — revoke
        // first (DELETE), then declare — never a silent side effect of a POST.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const existing = await services.declarations.get(auth.userId);
          if (
            existing !== null &&
            existing.status === 'verified' &&
            existing.verificationLevel === 'reviewer_verified'
          ) {
            return c.json(
              deny(
                'declaration_verified',
                'Your region is verified. Revoke the current declaration first, then declare the new region.',
              ),
              409,
            );
          }
          const record = await services.declarations.upsert(
            {
              userId: auth.userId,
              declaredRegion: body.declared_region,
              status: 'pending',
              verificationLevel: 'unverified',
              evidenceRef: body.evidence_ref ?? null,
              verifiedAt: null,
              verifiedBy: null,
              createdAt: existing?.createdAt ?? nowIso,
              updatedAt: nowIso,
            },
            // CAS only when a prior row exists — a concurrent verify is the write
            // to preserve; a first declaration has no premises to lose.
            existing === null
              ? undefined
              : {
                  declaredRegion: existing.declaredRegion,
                  status: existing.status,
                  updatedAt: existing.updatedAt,
                },
          );
          if (record !== null) {
            await getIdentityServices().audit.append({
              actorUserId: auth.userId,
              eventType: 'region_declaration_change',
              context: { setting: 'declare', new_value: body.declared_region },
            });
            services.metrics.increment('compliance.declaration.created');
            return c.json({ declaration: declarationToWire(record) }, 201);
          }
          // record === null ⇒ a CAS miss (only reachable when `existing` was
          // non-null): the row changed under us, so loop and re-read/re-check.
        }
        return c.json(
          deny('declaration_changed', 'The declaration changed while being updated; try again.'),
          409,
        );
      },
    )

    // Revocation of a NON-verified declaration reverts resolution to the locale
    // subtag or unknown.  A VERIFIED declaration cannot be self-revoked (see the
    // guard): that would be the SAME self-service downgrade the POST guard blocks
    // — a verified-BLOCKED member dropping to a more-permissive locale to reach
    // the routes that reject only an explicit `blocked` (wallet-connect/testnet).
    // Removing a verified region is reviewer action (`POST …/verify` with
    // `decision: 'revoke'`), never a member DELETE.
    .delete('/region/declaration', authMiddleware(), async (c) => {
      const auth = requireAuth(c);
      const services = getComplianceServices();
      const nowIso = new Date(services.now()).toISOString();
      // READ → GUARD → CAS, retried (mirrors the POST).  A member cannot
      // self-revoke a VERIFIED declaration, and the guard alone is a TOCTOU: a
      // reviewer verifying the pending row between our read and our write would be
      // clobbered to `revoked`/`unverified` by an unconditional upsert — the same
      // self-service downgrade the guard forbids.  So the write CASes on the read
      // premises; a miss re-reads (now sees the verify) and 409s.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = await services.declarations.get(auth.userId);
        if (existing === null) return c.json(notFound, 404);
        if (existing.status === 'verified' && existing.verificationLevel === 'reviewer_verified') {
          return c.json(
            deny(
              'declaration_verified',
              'Your region is verified and cannot be self-revoked; contact compliance to change it.',
            ),
            409,
          );
        }
        const record = await services.declarations.upsert(
          {
            ...existing,
            status: 'revoked',
            verificationLevel: 'unverified',
            verifiedAt: null,
            verifiedBy: null,
            updatedAt: nowIso,
          },
          {
            declaredRegion: existing.declaredRegion,
            status: existing.status,
            updatedAt: existing.updatedAt,
          },
        );
        if (record !== null) {
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'region_declaration_change',
            context: { setting: 'revoke' },
          });
          return c.json({ revoked: true });
        }
        // CAS miss: the row changed under us — re-read and re-check.
      }
      return c.json(
        deny('declaration_changed', 'The declaration changed while being updated; try again.'),
        409,
      );
    })

    .get('/disclosures', authMiddleware(), async (c) => {
      const auth = requireAuth(c);
      const services = getComplianceServices();
      const listed = await listDisclosuresForUser(buildDisclosureDeps(services), auth.userId);
      if (listed.unavailable) {
        // Region resolution failed (declaration-store outage): an empty 200
        // would read as "nothing to acknowledge" while the financial gates are
        // failing closed on the same outage.
        return c.json(
          deny('region_unavailable', 'Your region could not be resolved right now.'),
          503,
        );
      }
      return c.json(
        disclosureListResponseSchema.parse({
          disclosures: listed.disclosures.map((d) => ({
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
        if (gate.unavailable) {
          // The ack DID record, but the follow-up requirement probe hit an
          // outage: `remaining: []` here would read as gate-cleared and send
          // the client straight into an intent create that 503s on the same
          // outage.  The response contract cannot say "unknown" (the client
          // envelope is strict — bundle-rollout compat), so report the outage;
          // the retry re-acknowledges idempotently and returns the true set.
          return c.json(
            deny(
              'region_unavailable',
              'Your acknowledgment was saved, but the remaining requirements could not be verified — try again shortly.',
            ),
            503,
          );
        }
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

    // WS-N.1.1e — the audited policy write.  EXPANDING availability requires
    // the counsel four-eyes gate (`policyChangeRequiresCounsel`, decided
    // against the prior ACTIVE policy INSIDE the chained unit) IN ADDITION to
    // the validatePolicy legal_approval_ref invariant — expanding is the
    // dangerous direction.  A replacement document that merely CARRIES an
    // already-approved `enabled` cell forward while narrowing another stays
    // open to the compliance role, so compliance can shrink availability in
    // an approved region without counsel being online.
    .post(
      '/admin/policies',
      authMiddleware(),
      requireCompliance(),
      policyWriteBudget,
      zValidator('json', policyCreateRequestSchema),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const body = c.req.valid('json');
        const { reason, approval_ref, ...policyInput } = body;
        // Expanding availability turns real funds on for a whole region, so it
        // takes the COUNSEL capability — not merely a compliance reviewer
        // quoting an approval reference at themselves.  The reference records
        // WHICH legal approval authorizes it (validatePolicy also ties
        // `enabled` to a recorded `legal_approval_ref`); the session proves
        // counsel actually made the change.  The capability is resolved here;
        // the DECISION runs inside the unit against the same prior-active
        // read the audit entry records (see CounselRequiredError).
        const actorIsCounsel = isCounsel(auth.roles);
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
              const activeNow = await stores.policies.activeForRegion(
                policyInput.country_or_region,
                nowIso,
              );
              previous = activeNow;
              // TIMELINE arm: a non-counsel write must take effect NOW — its
              // `effective_at` must land in [active-row, now].  Policies are
              // insert-only and the engine serves the greatest effective_at ≤
              // now, so a FUTURE-dated row is a scheduling act: a reviewer
              // could otherwise plant a carry-forward of today's approved
              // document dated after a counsel-scheduled narrowing and
              // silently re-expand the region when the date arrives (the
              // delta below would read it as a no-op against TODAY's policy).
              // A back-date behind the active row is the same class (a
              // timeline reorder).  Immediate narrowing — the reviewer's
              // whole use case — is unaffected.
              const effectiveAtMs = Date.parse(policyInput.effective_at);
              if (
                !actorIsCounsel &&
                (effectiveAtMs > services.now() ||
                  (activeNow !== null && effectiveAtMs < Date.parse(activeNow.effectiveAt)))
              ) {
                throw new CounselRequiredError('scheduling');
              }
              // The delta BASELINE is the policy in force at the new
              // document's own effective instant (its timeline predecessor)
              // — for a window-checked non-counsel write this IS the active
              // row, and for a counsel-scheduled write it is whatever the
              // schedule says precedes it, so scheduling a re-enable AFTER a
              // scheduled narrowing correctly demands the approval ref.
              // Validated exactly as the engine reads it: a nonconforming
              // stored row is ABSENT (fail-closed), so nothing in it can be
              // "carried forward" — every enabled cell in the new document
              // then counts as an expansion.  A policy-store outage throws
              // out of the unit (503 below); nothing is gated open on an
              // unread prior.
              const baselineRow = await stores.policies.activeForRegion(
                policyInput.country_or_region,
                policyInput.effective_at,
              );
              let prior: JurisdictionFeaturePolicy | null = null;
              if (baselineRow !== null) {
                const priorValidated = validatePolicy(baselineRow.document);
                if (priorValidated.ok) prior = priorValidated.policy;
              }
              const delta = policyChangeRequiresCounsel(prior, validated.policy);
              if (delta.required && !actorIsCounsel) throw new CounselRequiredError('role');
              if (delta.required && approval_ref === undefined) {
                throw new CounselRequiredError('approval_ref');
              }
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
          if (error instanceof CounselRequiredError) {
            // The unit rolled back: no policy row, no chain entry.
            const messages = {
              role: 'Expanding availability requires legal counsel (the compliance role may only narrow it or carry an approved policy forward unchanged).',
              approval_ref:
                'Expanding availability requires a counsel approval reference (four-eyes).',
              scheduling:
                'Scheduling or re-ordering the policy timeline requires legal counsel — a compliance write takes effect immediately (effective_at between the active policy and now).',
            } as const;
            return c.json(deny('counsel_approval_required', messages[error.missing]), 403);
          }
          // The `(region, effective_at)` unique is the only other expected
          // failure here; anything else (an audit- or policy-store outage)
          // rolled the whole unit back, so nothing went live.
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
        const isVerify = body.decision === 'verify';
        const isRevoke = body.decision === 'revoke';
        // `verify`/`reject` apply ONLY to a PENDING declaration: a stale reviewer
        // form or a duplicate queue action on an already-`verified` row would
        // otherwise CAS it back to `pending`/`unverified`, silently disabling
        // real-fund region resolution behind the member's back.  `revoke` is the
        // exception — it is the DELIBERATE reviewer path to remove a VERIFIED
        // region (a member cannot self-revoke one, so this is the only way to
        // change it), and it may also clear a still-pending declaration.
        if (!isRevoke && existing.status !== 'pending') {
          return c.json(
            deny(
              'declaration_not_pending',
              'This declaration is no longer pending; only a pending declaration can be reviewed here.',
            ),
            409,
          );
        }
        const nowIso = new Date(services.now()).toISOString();
        const record = await services.declarations.upsert(
          {
            ...existing,
            status: isVerify ? 'verified' : isRevoke ? 'revoked' : 'pending',
            verificationLevel: isVerify ? 'reviewer_verified' : 'unverified',
            verifiedAt: isVerify ? nowIso : null,
            verifiedBy: isVerify ? auth.userId : null,
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
      const intentRows = await Promise.all(
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
      );
      // ONE row per case.  A high-value review is opened by `preflightIntent`
      // keyed to the intent, so the same case arrives on both passes — and only
      // the intent row carries Release/Reject.  Rendering both let a reviewer
      // resolve the case-only row, believe the review cleared, and leave the
      // intent `flagged` with the transfer still held.  The intent row wins,
      // because it is the one that can act.
      const representedByIntent = new Set(intentRows.map((row) => row.case.case_id));
      const items = [
        ...fraudClass
          .filter((record) => !representedByIntent.has(record.caseId))
          .map((record) => ({
            case: caseToWire(record),
            payment_intent_id: null,
            payment_compliance_state: null,
            sla_due_at: slaDueAt(services, record),
          })),
        ...intentRows,
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
        // RECORD THE DECISION FIRST, then clear.  The money must not become
        // movable (flagged → cleared) until the durable reviewer decision is on
        // the chain: clearing first opened a window in which a client could
        // resume the now-cleared intent and SUBMIT before the decision recorded,
        // then the record fails and the revert cannot undo an on-chain action —
        // funds moved with no durable account of who allowed them.  Recording
        // first fails CLOSED: a decision-recorded-but-not-cleared intent stays
        // held (the safe direction), never a cleared-but-unrecorded one.
        const held = await getTreasuryServices().intents.getById(body.payment_intent_id);
        // Not flagged, or already TERMINAL: a reviewer who loaded the queue while
        // the intent was live may click Release after the expiry/clawback path
        // moved it to `abandoned`/`failed` — the compliance CAS would still flip
        // the column and report `cleared` for an intent that can never quote or
        // submit.  Re-check the execution state here (the queue query already
        // filters it, but this endpoint is reached with a stale id).
        if (
          held === null ||
          held.complianceState !== 'flagged' ||
          TERMINAL_INTENT_STATES.has(held.executionState)
        ) {
          return c.json(deny('not_flagged', 'The intent is not held for review.'), 409);
        }
        const recorded = await recordIntentReviewDecision(services, {
          intent: {
            paymentIntentId: held.paymentIntentId,
            userId: held.userId,
            roomId: held.roomId,
            targetType: held.targetType,
            amount: held.amount,
          },
          decision: 'release',
          reason: body.reason,
          actorUserId: auth.userId,
        });
        if (!recorded) {
          return c.json(
            deny('audit_unavailable', 'The release was not applied: it could not be recorded.'),
            503,
          );
        }
        // The decision is durable — NOW clear.  A CAS miss (a concurrent
        // reviewer, or the intent left `flagged`) leaves the decision recorded
        // and the intent unchanged; no funds moved, and a retry is idempotent.
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
        // RECORD THE DECISION FIRST, then block — symmetric with Release, and for
        // the same reason.  A block is as consequential as a release: it stops a
        // member's funds.  Blocking first opened a window in which the case-chain
        // write could fail AFTER the `flagged → blocked` CAS while the
        // expiry/clawback sweep terminalized the timed intent before the
        // best-effort revert landed — leaving it blocked/abandoned with NO durable
        // reviewer decision.  Recording first fails CLOSED: a
        // decision-recorded-but-not-blocked intent stays `flagged` (held), never a
        // blocked/terminal one with no account of who rejected it.
        const held = await getTreasuryServices().intents.getById(body.payment_intent_id);
        if (
          held === null ||
          held.complianceState !== 'flagged' ||
          TERMINAL_INTENT_STATES.has(held.executionState)
        ) {
          return c.json(deny('not_flagged', 'The intent is not held for review.'), 409);
        }
        const recorded = await recordIntentReviewDecision(services, {
          intent: {
            paymentIntentId: held.paymentIntentId,
            userId: held.userId,
            roomId: held.roomId,
            targetType: held.targetType,
            amount: held.amount,
          },
          decision: 'reject',
          reason: body.reason,
          actorUserId: auth.userId,
        });
        if (!recorded) {
          return c.json(
            deny('audit_unavailable', 'The rejection was not applied: it could not be recorded.'),
            503,
          );
        }
        // The decision is durable — NOW block.  A CAS miss (a concurrent reviewer,
        // or the intent left `flagged`) leaves the decision recorded and the intent
        // unchanged; no funds moved, and a retry is idempotent.
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
        const { reason } = c.req.valid('json');
        const nowIso = new Date(services.now()).toISOString();
        // DERIVE the case subject from the wallet's OWNER, never a caller-supplied
        // ref: the pin blocks the wallet by `walletAccountId`, so a wrong subject
        // would leave the ACTUAL owner fund-blocked with no case explaining it
        // while an unrelated user got a spurious high-risk case.  Fail closed on an
        // unknown wallet — a pin with no real subject cannot carry its case.
        const subjectRef = await services.walletOwner(walletAccountId);
        if (subjectRef === null) {
          return c.json(
            deny('wallet_unknown', 'The wallet could not be resolved to an owner.'),
            404,
          );
        }
        // ONE unit: the pin and its case are the two halves of the same response
        // (the same invariant `buildSanctionedWalletLinkHook` keeps at link) — a
        // pin with no case is a wallet frozen with nothing in the queue explaining
        // why.  Idempotent per wallet: re-pinning returns the active pin unchanged
        // and the `manual-pin:<wallet>` key dedups the case.
        const outcome = await runChainedUnit(
          services.transactor,
          async (stores) => {
            // `pin` is idempotent: it returns the ACTIVE pin unchanged, or a new
            // row after a release.  Key the case on THAT pin's id, not the wallet:
            // a permanent `manual-pin:<wallet>` key would hand a re-pin (after the
            // first case was released + resolved) the OLD closed case, leaving the
            // fresh restriction with no open reviewer-queue / DSAR record.  Per
            // active pin ⇒ a re-pin after release opens a fresh case, while a
            // re-pin of a still-active pin dedups onto its own.
            const pin = await stores.pins.pin({
              id: services.uuid(),
              walletAccountId,
              reason,
              pinnedByRef: services.opaqueRef(auth.userId),
              createdAt: nowIso,
              releasedAt: null,
              releasedByRef: null,
            });
            return createCaseInTx(stores, buildCaseDeps(services), {
              subjectKind: 'user',
              subjectRef,
              triggerType: 'manual',
              riskLevel: 'high',
              note: `Wallet manually pinned by a compliance reviewer: ${reason}`,
              idempotencyKey: `manual-pin:${pin.id}`,
            });
          },
          'manual wallet pin',
        ).catch((error: unknown) => ({ ok: false as const, error }));
        if (!('ok' in outcome) || !outcome.ok) {
          services.metrics.increment('compliance.wallet_pin.unrecorded');
          return c.json(deny('pin_unavailable', 'The pin could not be recorded.'), 503);
        }
        // Announced OUTSIDE the unit (an external side effect must not replay if a
        // chain fork runs the unit twice) and only for a case this call opened.
        if (outcome.created) {
          await announceCaseCreated(buildCaseDeps(services), outcome.record, subjectRef);
        }
        services.metrics.increment('compliance.wallet_pin.created');
        return c.json({ pinned: true, created_at: nowIso }, 201);
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
        const { walletAccountId } = c.req.valid('param');
        const pin = await services.pins.activeForWallet(walletAccountId);
        if (pin === null) return c.json(notFound, 404);
        // A pin's INCIDENT CASE keeps the wallet `high` on its own —
        // `createWalletRisk` derives `high` from any open critical case for the
        // owner as well as from the pin — so releasing the pin while that case is
        // still open would report `{ released: true }` on a wallet the risk engine
        // STILL blocks.  Require the linked case to be resolved FIRST, through the
        // case console with a deliberate outcome + notes; never auto-clear a
        // sanctions/manual incident case as a side effect of a pin deletion.  The
        // case is keyed on THIS pin's id by both pin-opening paths.
        for (const key of [`sanctions:link:${pin.id}`, `manual-pin:${pin.id}`]) {
          const linked = await services.cases.findByIdempotencyKey(key);
          if (linked !== null && linked.reviewState !== 'resolved') {
            return c.json(
              deny(
                'case_open',
                'Resolve the linked compliance case before releasing the pin; the wallet stays restricted while its incident case is open.',
              ),
              409,
            );
          }
        }
        const released = await services.pins.release(
          walletAccountId,
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
            idempotencyKey: body.idempotency_key,
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
          idempotencyKey: body.idempotency_key,
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

    // WS-N.2.3d — counsel records that the subject MAY now be notified (a gag
    // order lifted).  This is the ONLY transition that clears a produced-but-
    // unnotified request's `userNotifiedAt`, so the anti-tipping-off suppression
    // lasts only as long as the legal restriction — never forever.
    .post(
      '/admin/lawful-access/:requestId/notify',
      authMiddleware(),
      requireCounsel(),
      zValidator('param', z.object({ requestId: uuidSchema })),
      async (c) => {
        const auth = requireAuth(c);
        const services = getComplianceServices();
        const result = await notifyLawfulAccessSubject(buildLawfulDeps(services), {
          requestId: c.req.valid('param').requestId,
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
