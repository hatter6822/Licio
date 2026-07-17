// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N compliance BFF client: feature availability, the identity-free region
// declaration (WS-N.1.1f — declared, NEVER detected: §19.1), and consumer
// risk disclosures + acknowledgments (WS-N.1.2d).  One thin function per
// endpoint; every response zod-validated before it can reach the TanStack
// Query cache (data-fetching ABSOLUTE).
import {
  type CaseListResponse,
  type CaseResolutionOutcome,
  caseListResponseSchema,
  type DisclosureListResponse,
  disclosureListResponseSchema,
  type FeatureAvailabilityResponse,
  type FinancialComplianceCase,
  type FraudQueueResponse,
  featureAvailabilityResponseSchema,
  financialComplianceCaseSchema,
  fraudQueueResponseSchema,
  type RegionDeclarationRequest,
  type RegionResolutionResponse,
  regionDeclarationViewSchema,
  regionResolutionResponseSchema,
} from '@licio/shared';
import { z } from 'zod';
import { client, parseResponse } from './api.js';

/** WS-N.1.1c — the fail-closed availability evaluation for the signed-in user. */
export async function fetchFeatureAvailability(): Promise<FeatureAvailabilityResponse> {
  const res = await client.v1.compliance.availability.$get();
  return parseResponse(res, featureAvailabilityResponseSchema);
}

/** WS-N.1.1b — the current resolution (region + basis + declaration state). */
export async function fetchRegionResolution(): Promise<RegionResolutionResponse> {
  const res = await client.v1.compliance.region.$get();
  return parseResponse(res, regionResolutionResponseSchema);
}

const declarationEnvelopeSchema = z.object({ declaration: regionDeclarationViewSchema }).strict();

/** WS-N.1.1f — declare a region (recorded PENDING; verification is the only
 *  path to it becoming a resolution basis — fail-closed). */
export async function declareRegion(
  request: RegionDeclarationRequest,
): Promise<z.infer<typeof declarationEnvelopeSchema>> {
  const res = await client.v1.compliance.region.declaration.$post({ json: request });
  return parseResponse(res, declarationEnvelopeSchema);
}

const revokeEnvelopeSchema = z.object({ revoked: z.literal(true) }).strict();

/** Revocation reverts resolution to the locale subtag or unknown. */
export async function revokeRegionDeclaration(): Promise<void> {
  const res = await client.v1.compliance.region.declaration.$delete();
  await parseResponse(res, revokeEnvelopeSchema);
}

/** WS-N.1.2d — the region's published disclosures + the user's ack status. */
export async function fetchDisclosures(): Promise<DisclosureListResponse> {
  const res = await client.v1.compliance.disclosures.$get();
  return parseResponse(res, disclosureListResponseSchema);
}

const ackEnvelopeSchema = z
  .object({
    acknowledged: z.literal(true),
    remaining: z.array(z.object({ id: z.string(), version: z.number() }).loose()),
  })
  .strict();

/** Acknowledge one disclosure version; returns the refs still outstanding. */
export async function acknowledgeDisclosure(
  disclosureId: string,
  version: number,
): Promise<z.infer<typeof ackEnvelopeSchema>> {
  const res = await client.v1.compliance.disclosures.acknowledge.$post({
    json: { disclosure_id: disclosureId, version },
  });
  return parseResponse(res, ackEnvelopeSchema);
}

// ---------------------------------------------------------------------------
// The compliance console surface (WS-N.2.1c/2.2c) — server-gated to the
// compliance role + active MFA; a non-reviewer sees an access notice.
// ---------------------------------------------------------------------------

export async function adminListCases(): Promise<CaseListResponse> {
  const res = await client.v1.compliance.admin.cases.$get({ query: {} });
  return parseResponse(res, caseListResponseSchema);
}

const caseEnvelopeSchema = z.object({ case: financialComplianceCaseSchema }).strict();

export type CaseAction = 'begin' | 'escalate' | 'reopen';

/** One guarded state-machine action (assign/resolve have dedicated calls). */
export async function adminCaseAction(
  caseId: string,
  action: CaseAction,
  reason?: string,
): Promise<FinancialComplianceCase> {
  const res =
    action === 'begin'
      ? await client.v1.compliance.admin.cases[':caseId'].begin.$post({ param: { caseId } })
      : action === 'escalate'
        ? await client.v1.compliance.admin.cases[':caseId'].escalate.$post({
            param: { caseId },
            json: { reason: reason ?? 'escalated from the console' },
          })
        : await client.v1.compliance.admin.cases[':caseId'].reopen.$post({
            param: { caseId },
            json: { reason: reason ?? 'reopened from the console' },
          });
  return (await parseResponse(res, caseEnvelopeSchema)).case;
}

export async function adminAssignCase(
  caseId: string,
  assigneeUserId: string,
): Promise<FinancialComplianceCase> {
  const res = await client.v1.compliance.admin.cases[':caseId'].assign.$post({
    param: { caseId },
    json: { assignee_user_id: assigneeUserId },
  });
  return (await parseResponse(res, caseEnvelopeSchema)).case;
}

export async function adminResolveCase(
  caseId: string,
  outcome: CaseResolutionOutcome,
  notes: string,
): Promise<FinancialComplianceCase> {
  const res = await client.v1.compliance.admin.cases[':caseId'].resolve.$post({
    param: { caseId },
    json: { outcome, notes },
  });
  return (await parseResponse(res, caseEnvelopeSchema)).case;
}

export async function adminFetchFraudQueue(): Promise<FraudQueueResponse> {
  const res = await client.v1.compliance.admin['fraud-queue'].$get();
  return parseResponse(res, fraudQueueResponseSchema);
}

const intentReviewEnvelopeSchema = z
  .object({ payment_intent_id: z.string(), compliance_state: z.string() })
  .strict();

/** Release (flagged → cleared) or reject (flagged → blocked) a held intent. */
export async function adminReviewIntent(
  decision: 'release' | 'reject',
  paymentIntentId: string,
  reason: string,
): Promise<z.infer<typeof intentReviewEnvelopeSchema>> {
  const res =
    decision === 'release'
      ? await client.v1.compliance.admin['fraud-queue'].release.$post({
          json: { payment_intent_id: paymentIntentId, reason },
        })
      : await client.v1.compliance.admin['fraud-queue'].reject.$post({
          json: { payment_intent_id: paymentIntentId, reason },
        });
  return parseResponse(res, intentReviewEnvelopeSchema);
}

/** Verify/reject a pending region declaration, or REVOKE a verified one, after
 *  evidence review (WS-N.1.1f).  `revoke` is the reviewer's ONLY path to remove a
 *  verified region — a member DELETE is refused (409) so a self-downgrade cannot
 *  drop the verified basis to a more-permissive locale rung; after a revoke the
 *  member may redeclare. */
export async function adminVerifyDeclaration(
  userId: string,
  decision: 'verify' | 'reject' | 'revoke',
  note: string,
): Promise<void> {
  const res = await client.v1.compliance.admin.declarations[':userId'].verify.$post({
    param: { userId },
    json: { decision, note },
  });
  await parseResponse(res, z.object({ declaration: regionDeclarationViewSchema }).strict());
}
