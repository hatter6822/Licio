// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U GovernancePolicyBundle (SPEC §16.6, §24.2/§24.6; ADR-9). The content-
// addressed, member-downloadable artifact a member proposes and members ratify (the steward validates).
// The in-room moderation MODEL is an LLM (the deterministic policy-DSL was
// removed), so what the community ratifies + downloads is the MODERATION PROMPT
// that conditions the platform model, the natural-language prompt templates, the
// config, and the capabilities the bundle requests (the community-voted bound the
// deterministic wrapper enforces). The digest is computed by the caller over
// `canonicalize(bundle)` (node:crypto in the API, SubtleCrypto in the browser)
// and is the hash-pin members verify — so the exact prompt + config + capability
// set that govern the room are auditable and reproducible even though the model's
// individual classifications are not bit-reproducible.

import { hubModelSelectionSchema } from '@licio/shared';
import { z } from 'zod';
import { capabilitySchema } from './capability.js';

/** Bundle-level natural-language behaviour knobs (deterministic defaults). */
export const policyBundleConfigSchema = z.object({
  summaryStyle: z.enum(['neutral_brief', 'neutral_detailed']).default('neutral_brief'),
  explanationVerbosity: z.enum(['terse', 'standard']).default('standard'),
});
export type PolicyBundleConfig = z.infer<typeof policyBundleConfigSchema>;

export const governancePolicyBundleSchema = z.object({
  bundleId: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  /** The community-ratified moderation prompt (the "model" — it conditions the
   *  platform LLM for this room's norms). The deterministic wrapper bounds every
   *  resulting classification (escalate-to-review ceiling + capability clamp),
   *  so the prompt cannot grant authority the community did not vote for. */
  moderationPrompt: z.string().min(1).max(20_000),
  /** Prompt templates for the advisory NL surfaces, keyed by template id. */
  promptTemplates: z.record(z.string().min(1).max(64), z.string().max(8_000)),
  config: policyBundleConfigSchema,
  /** Capabilities the bundle requests; intersected with the law-pack at derivation. */
  requestedCapabilities: z.array(capabilitySchema),
  /** WS-U model candidacy: the steward's per-role hub model selection —
   *  revision-pinned huggingface.co references for the room's MODERATION and/or
   *  ADJUDICATION model. Content-addressed with the bundle (members ratify the
   *  exact weights reference), server-verified against the hub at propose time,
   *  and admission-evaluated through the platform floor-safety machinery before
   *  eligibility. Omitted (or a role omitted) ⇒ the project-wide default model
   *  serves that role. */
  modelSelection: hubModelSelectionSchema.optional(),
});
export type GovernancePolicyBundle = z.infer<typeof governancePolicyBundleSchema>;
