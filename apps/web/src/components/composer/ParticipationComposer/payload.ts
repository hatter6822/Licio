// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Composer values → wire payload (WS-G.3.4–3.6).  The builder assembles the
// flat per-type create shape from the catalogue's wire-named fields and
// validates it through the SHARED `contributionCreateSchema` — the same
// schema the server enforces, so client-side validation can never drift
// from the server's rules (WS-G definition of done #2).
import {
  type Citation,
  type ContributionCreate,
  citationSchema,
  contributionCreateSchema,
} from '@licio/shared';
import type { ComposerMode, ComposerValues } from './modes.js';

export interface PayloadContext {
  threadId: string;
  clientDraftId: string;
  /** Set when answering a question (WS-G.3.6d) or nesting a reply. */
  parentContributionId?: string;
  /** Pre-selected flag target (WS-G.3.4c context-menu flow). */
  targetContributionId?: string;
  /** Uploaded attachment ids (WS-G.3.7b). */
  attachmentIds?: string[];
  /** Lens vantage (WS-G.2.4). */
  lensId?: string;
}

export type PayloadResult =
  | { ok: true; payload: ContributionCreate }
  | { ok: false; fieldErrors: Record<string, string> };

const trimmed = (value: string | undefined): string => (value ?? '').trim();

/** Parse the citations field: one URL/DOI per line → citation objects. */
export function parseCitations(raw: string | undefined): Citation[] {
  return trimmed(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((url) => ({ url }));
}

/** Parse a comma/whitespace-separated id list (synthesis branch selector). */
function parseIdList(raw: string | undefined): string[] {
  return trimmed(raw)
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function optional(value: string | undefined): string | undefined {
  const v = trimmed(value);
  return v.length > 0 ? v : undefined;
}

/** Assemble the flat wire object for a mode (pre-validation). */
export function assemblePayload(
  mode: ComposerMode,
  values: ComposerValues,
  context: PayloadContext,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: mode,
    thread_id: context.threadId,
    client_draft_id: context.clientDraftId,
    body: trimmed(values['body']),
  };
  if (context.parentContributionId !== undefined) {
    base['parent_contribution_id'] = context.parentContributionId;
  }
  if (context.lensId !== undefined) base['lens_id'] = context.lensId;
  if (context.attachmentIds !== undefined && context.attachmentIds.length > 0) {
    base['attachment_ids'] = context.attachmentIds;
  }
  switch (mode) {
    case 'question':
      return {
        ...base,
        ...(optional(values['target_claim_id'])
          ? { target_claim_id: optional(values['target_claim_id']) }
          : {}),
      };
    case 'answer': {
      const citations = parseCitations(values['citations']);
      return { ...base, ...(citations.length > 0 ? { citations } : {}) };
    }
    case 'evidence':
      return {
        ...base,
        citations: parseCitations(values['citations']),
        target_claim_id: optional(values['target_claim_id']),
        ...(optional(values['evidence_type'])
          ? { evidence_type: optional(values['evidence_type']) }
          : {}),
      };
    case 'correction':
      return {
        ...base,
        citations: parseCitations(values['citations']),
        target_claim_id: optional(values['target_claim_id']),
        ...(optional(values['target_text_excerpt'])
          ? { target_text_excerpt: optional(values['target_text_excerpt']) }
          : {}),
      };
    case 'synthesis':
      return {
        ...base,
        included_branch_ids: parseIdList(values['included_branch_ids']),
        ...(optional(values['uncertainty_note'])
          ? { uncertainty_note: optional(values['uncertainty_note']) }
          : {}),
      };
    case 'counterexample':
      return {
        ...base,
        target_claim_id: optional(values['target_claim_id']),
        relevance_explanation: trimmed(values['relevance_explanation']),
        ...(optional(values['source_url']) ? { source_url: optional(values['source_url']) } : {}),
      };
    case 'explanation':
      return {
        ...base,
        ...(optional(values['assumptions'])
          ? { assumptions: optional(values['assumptions']) }
          : {}),
        ...(optional(values['caveats']) ? { caveats: optional(values['caveats']) } : {}),
      };
    case 'local_context':
      return {
        ...base,
        scope: trimmed(values['scope']),
        ...(optional(values['location']) ? { location: optional(values['location']) } : {}),
        ...(optional(values['time_context'])
          ? { time_context: optional(values['time_context']) }
          : {}),
      };
    case 'direct_experience':
      return {
        ...base,
        scope: trimmed(values['scope']),
        ...(optional(values['location']) ? { location: optional(values['location']) } : {}),
        ...(optional(values['time_context'])
          ? { time_context: optional(values['time_context']) }
          : {}),
        // The checkbox stores 'true' when checked; the schema requires literal true.
        ...(values['privacy_acknowledged'] === 'true' ? { privacy_acknowledged: true } : {}),
      };
    case 'moderation_concern':
      return {
        ...base,
        target_contribution_id:
          context.targetContributionId ?? optional(values['target_contribution_id']),
        reason_code: trimmed(values['reason_code']),
        urgency: optional(values['urgency']) ?? 'normal',
      };
    case 'meta_discussion':
      return {
        ...base,
        ...(optional(values['target_contribution_id'])
          ? { target_contribution_id: optional(values['target_contribution_id']) }
          : {}),
      };
  }
}

/** Build + validate the payload with field-level errors for the form. */
export function buildContributionPayload(
  mode: ComposerMode,
  values: ComposerValues,
  context: PayloadContext,
): PayloadResult {
  const candidate = assemblePayload(mode, values, context);
  const parsed = contributionCreateSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, payload: parsed.data };
  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? 'body');
    if (!(field in fieldErrors)) fieldErrors[field] = issue.message;
  }
  return { ok: false, fieldErrors };
}

/** Validate a single pasted/typed citation line (UI affordance). */
export function isValidCitationUrl(url: string): boolean {
  return citationSchema.safeParse({ url: url.trim() }).success;
}
