// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U GovernancePolicyBundle (SPEC §16.6, §24.2/§24.6; ADR-1). The content-
// addressed, member-downloadable artifact a steward proposes and members ratify:
// a moderation rule-set (the policy DSL), prompt templates for the natural-
// language surfaces (ADR-3), config, and the capabilities the bundle requests.
// The digest is computed by the caller over `canonicalize(bundle)` (node:crypto
// in the API, SubtleCrypto in the browser) and is the hash-pin members verify.

import { z } from 'zod';
import { capabilitySchema } from './capability.js';
import { moderationRuleSchema } from './moderation.js';

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
  /** The deterministic moderation rule-set (the "model"). */
  moderationRules: z.array(moderationRuleSchema).max(512),
  /** Prompt templates for the advisory NL surfaces, keyed by template id. */
  promptTemplates: z.record(z.string().min(1).max(64), z.string().max(8_000)),
  config: policyBundleConfigSchema,
  /** Capabilities the bundle requests; intersected with the law-pack at derivation. */
  requestedCapabilities: z.array(capabilitySchema),
});
export type GovernancePolicyBundle = z.infer<typeof governancePolicyBundleSchema>;
