// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed client flows for the WS-J trust & safety surface: the user-facing
// controls (report, block, mute, appeal, support contact, moderation-notice
// inbox) and the steward console (report/appeal queues, review, action palette,
// audit viewer + transparency export).  Every response is zod-validated before
// it can enter the TanStack Query cache (the WS-C.1.2 boundary guarantee).
import {
  type AppealCreatedResponse,
  type AppealDecisionRequest,
  type AppealDecisionResponse,
  type AppealEligibilityView,
  type AppealQueueResponse,
  type AppealReviewResponse,
  type AuditExportResponse,
  type AuditListResponse,
  appealCreatedResponseSchema,
  appealDecisionResponseSchema,
  appealEligibilityViewSchema,
  appealQueueResponseSchema,
  appealReviewResponseSchema,
  auditExportResponseSchema,
  auditListResponseSchema,
  type BlockListResponse,
  type BlockRecordView,
  blockListResponseSchema,
  blockRecordSchema,
  type CaseReviewResponse,
  type ConsoleAction,
  type CreateAppealRequest,
  type CreateReportRequest,
  caseReviewResponseSchema,
  type EvidenceDecisionRequest,
  type EvidenceDecisionsResponse,
  type EvidenceDecisionView,
  type EvidenceQueueResponse,
  evidenceDecisionsResponseSchema,
  evidenceDecisionViewSchema,
  evidenceQueueResponseSchema,
  type IncidentQueueResponse,
  type IncidentResolveResponse,
  incidentQueueResponseSchema,
  incidentResolveResponseSchema,
  type ModerationActionResponse,
  type ModerationNoticeListResponse,
  type ModerationReasonCode,
  type MuteDuration,
  type MuteListResponse,
  type MuteRecordView,
  moderationActionResponseSchema,
  moderationNoticeListResponseSchema,
  muteListResponseSchema,
  muteRecordSchema,
  type OkResponse,
  okResponseSchema,
  type ReportCreatedResponse,
  type ReportQueueResponse,
  type RevertActionResponse,
  type ReviewerAvailability,
  type ReviewerStatusResponse,
  reportCreatedResponseSchema,
  reportQueueResponseSchema,
  revertActionResponseSchema,
  reviewerStatusResponseSchema,
  type SupportContactResponse,
  supportContactResponseSchema,
  type UrlVerdictResponse,
  urlVerdictResponseSchema,
} from '@licio/shared';
import { client, parseResponse } from './api.js';

// --- User-facing controls --------------------------------------------------

export async function fetchSupportContact(jurisdiction?: string): Promise<SupportContactResponse> {
  // A 2-letter declared-region hint surfaces LOCAL crisis/CSAM hotlines (§19.1
  // declared-region, never the client IP); omitted ⇒ the global fallback.
  const response = await client.v1['support-contact'].$get({
    query: jurisdiction ? { jurisdiction } : {},
  });
  return parseResponse(response, supportContactResponseSchema);
}

/** Submit a report directly (the online path; offline goes through the queue). */
export async function submitReport(request: CreateReportRequest): Promise<ReportCreatedResponse> {
  const response = await client.v1.reports.$post({ json: request });
  return parseResponse(response, reportCreatedResponseSchema);
}

export async function fetchBlocks(cursor?: string): Promise<BlockListResponse> {
  const response = await client.v1.blocks.$get({ query: cursor ? { cursor } : {} });
  return parseResponse(response, blockListResponseSchema);
}

/**
 * Block an account by its PUBLIC HANDLE — the only identifier a reader on a
 * content surface has (§19.5 keeps `author_user_id` off the public projection),
 * so this is the form every UI affordance uses, and the only form this client
 * ships.  The endpoint still accepts a user id for callers that hold one (the
 * console, offline replay); the browser never does, so a wrapper for it here
 * would be unreachable code.
 */
export async function createBlockByHandle(handle: string): Promise<BlockRecordView> {
  const response = await client.v1.blocks.$post({ json: { blocked_user_handle: handle } });
  return parseResponse(response, blockRecordSchema);
}

export async function removeBlock(blockId: string): Promise<OkResponse> {
  const response = await client.v1.blocks[':blockId'].$delete({ param: { blockId } });
  return parseResponse(response, okResponseSchema);
}

export async function fetchMutes(cursor?: string): Promise<MuteListResponse> {
  const response = await client.v1.mutes.$get({ query: cursor ? { cursor } : {} });
  return parseResponse(response, muteListResponseSchema);
}

/** Mute an account by its PUBLIC HANDLE — see {@link createBlockByHandle}. */
export async function createMuteByHandle(
  handle: string,
  duration?: MuteDuration,
): Promise<MuteRecordView> {
  const response = await client.v1.mutes.$post({
    json: { muted_user_handle: handle, ...(duration ? { duration } : {}) },
  });
  return parseResponse(response, muteRecordSchema);
}

export async function removeMute(muteId: string): Promise<OkResponse> {
  const response = await client.v1.mutes[':muteId'].$delete({ param: { muteId } });
  return parseResponse(response, okResponseSchema);
}

export async function fetchAppealEligibility(actionId: string): Promise<AppealEligibilityView> {
  const response = await client.v1.appeals.eligibility[':actionId'].$get({ param: { actionId } });
  return parseResponse(response, appealEligibilityViewSchema);
}

export async function createAppeal(request: CreateAppealRequest): Promise<AppealCreatedResponse> {
  const response = await client.v1.appeals.$post({ json: request });
  return parseResponse(response, appealCreatedResponseSchema);
}

export async function fetchModerationNotices(
  cursor?: string,
): Promise<ModerationNoticeListResponse> {
  const response = await client.v1.moderation.notices.$get({ query: cursor ? { cursor } : {} });
  return parseResponse(response, moderationNoticeListResponseSchema);
}

export async function markNoticeRead(noticeId: string): Promise<OkResponse> {
  const response = await client.v1.moderation.notices[':noticeId'].read.$post({
    param: { noticeId },
  });
  return parseResponse(response, okResponseSchema);
}

// --- Steward console -------------------------------------------------------

export interface QueueQuery {
  status?: ('new' | 'in_progress' | 'resolved' | 'escalated')[];
  severity?: ('minor' | 'moderate' | 'severe' | 'critical')[];
  assignment?: 'unassigned' | 'mine' | 'reviewer';
  cursor?: string;
}

export async function fetchReportQueue(query: QueueQuery = {}): Promise<ReportQueueResponse> {
  const response = await client.v1.moderation.queue.$get({ query });
  return parseResponse(response, reportQueueResponseSchema);
}

export async function fetchCase(caseId: string): Promise<CaseReviewResponse> {
  const response = await client.v1.moderation.cases[':caseId'].$get({ param: { caseId } });
  return parseResponse(response, caseReviewResponseSchema);
}

/** WS-J.2.6b: resolve the server-side redirect-chain malware verdict for an
 *  untrusted URL (reporter-supplied evidence, or a citation under source
 *  review) BEFORE the reviewer navigates to it (the fetch runs over the
 *  SSRF-hardened server fetcher — never from the reviewer's browser). */
export async function fetchUrlVerdict(url: string): Promise<UrlVerdictResponse> {
  const response = await client.v1.moderation['url-verdict'].$post({ json: { url } });
  return parseResponse(response, urlVerdictResponseSchema);
}

export async function assignCase(caseId: string, reviewerId: string): Promise<OkResponse> {
  const response = await client.v1.moderation.cases[':caseId'].assign.$post({
    param: { caseId },
    json: { reviewer_id: reviewerId },
  });
  return parseResponse(response, okResponseSchema);
}

export interface ApplyActionInput {
  targetType: 'content' | 'account' | 'room';
  targetId: string;
  action: ConsoleAction;
  reasonCode: ModerationReasonCode;
  caseId?: string;
  reviewerNote?: string;
  duration?: string;
}

export async function applyModerationAction(
  input: ApplyActionInput,
): Promise<ModerationActionResponse> {
  const response = await client.v1.moderation.actions.$post({
    json: {
      target_type: input.targetType,
      target_id: input.targetId,
      action: input.action,
      reason_code: input.reasonCode,
      ...(input.caseId ? { case_id: input.caseId } : {}),
      ...(input.reviewerNote ? { reviewer_note: input.reviewerNote } : {}),
      ...(input.duration ? { duration: input.duration } : {}),
    },
  });
  return parseResponse(response, moderationActionResponseSchema);
}

export async function revertModerationAction(
  actionId: string,
  reasonCode: ModerationReasonCode,
): Promise<RevertActionResponse> {
  const response = await client.v1.moderation.actions[':actionId'].revert.$post({
    param: { actionId },
    json: { reason_code: reasonCode },
  });
  return parseResponse(response, revertActionResponseSchema);
}

/** The caller's OWN stored availability — what the console initialises from.
 *  A fixed local default told a reviewer they were `available` while the server
 *  still had them out of the auto-assignment pool. */
export async function fetchReviewerStatus(): Promise<ReviewerStatusResponse> {
  const response = await client.v1.moderation['reviewer-status'].$get();
  return parseResponse(response, reviewerStatusResponseSchema);
}

export async function setReviewerStatus(status: ReviewerAvailability): Promise<OkResponse> {
  const response = await client.v1.moderation['reviewer-status'].$post({ json: { status } });
  return parseResponse(response, okResponseSchema);
}

export async function fetchAppealQueue(cursor?: string): Promise<AppealQueueResponse> {
  const response = await client.v1.moderation.appeals.$get({
    query: { status: 'pending', ...(cursor ? { cursor } : {}) },
  });
  return parseResponse(response, appealQueueResponseSchema);
}

export async function fetchAppeal(appealId: string): Promise<AppealReviewResponse> {
  const response = await client.v1.moderation.appeals[':appealId'].$get({ param: { appealId } });
  return parseResponse(response, appealReviewResponseSchema);
}

export async function decideAppeal(
  appealId: string,
  request: AppealDecisionRequest,
): Promise<AppealDecisionResponse> {
  const response = await client.v1.moderation.appeals[':appealId'].decision.$post({
    param: { appealId },
    json: request,
  });
  return parseResponse(response, appealDecisionResponseSchema);
}

export async function fetchAudit(query: {
  action?: string;
  cursor?: string;
}): Promise<AuditListResponse> {
  const response = await client.v1.moderation.audit.$get({ query });
  return parseResponse(response, auditListResponseSchema);
}

export async function exportAudit(): Promise<AuditExportResponse> {
  const response = await client.v1.moderation.audit.export.$get({ query: {} });
  return parseResponse(response, auditExportResponseSchema);
}

// --- Coordinated-report incidents (WS-J.2.6e, ROLE_INTEGRITY) ----------------

export async function fetchIncidents(cursor?: string): Promise<IncidentQueueResponse> {
  const response = await client.v1.moderation.incidents.$get({ query: cursor ? { cursor } : {} });
  return parseResponse(response, incidentQueueResponseSchema);
}

export async function resolveIncident(
  incidentId: string,
  resolution: 'cleared' | 'confirmed',
  note?: string,
): Promise<IncidentResolveResponse> {
  const response = await client.v1.moderation.incidents[':incidentId'].resolve.$post({
    param: { incidentId },
    json: { resolution, ...(note ? { note } : {}) },
  });
  return parseResponse(response, incidentResolveResponseSchema);
}

// --- Source review queue + decisions (STEWARD_ROLES.md ROLE_EVIDENCE) -------
//
// The console surfaces this plane as the "Sources" tab (sourcing is
// comment-centric — a comment carries citations); the ratified doctrine-role
// name and the `/v1/moderation/evidence-*` wire paths are unchanged, so these
// client functions stay wire-aligned.

/** The FIFO stream of citation-bearing contributions (sourced comments +
 *  corrections) with no source decision yet — oldest first. */
export async function fetchEvidenceQueue(cursor?: string): Promise<EvidenceQueueResponse> {
  const response = await client.v1.moderation['evidence-queue'].$get({
    query: cursor ? { cursor } : {},
  });
  return parseResponse(response, evidenceQueueResponseSchema);
}

/** Recent source decisions, newest first (the reviewability trail). */
export async function fetchEvidenceDecisions(cursor?: string): Promise<EvidenceDecisionsResponse> {
  const response = await client.v1.moderation['evidence-decisions'].$get({
    query: cursor ? { cursor } : {},
  });
  return parseResponse(response, evidenceDecisionsResponseSchema);
}

/** Record a source decision — source METADATA, never a content action
 *  (`mark-primary-source`/`flag-citation` annotate ONE citation; `clear` marks
 *  the contribution reviewed with no annotation). */
export async function applyEvidenceDecision(
  request: EvidenceDecisionRequest,
): Promise<EvidenceDecisionView> {
  const response = await client.v1.moderation['evidence-decisions'].$post({ json: request });
  return parseResponse(response, evidenceDecisionViewSchema);
}
