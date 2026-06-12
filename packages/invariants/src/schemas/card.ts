// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2b — the InvariantCard schema.
//
// Every invariant documents its operational profile in a card validated by
// THIS schema: who owns it, what it consumes and produces, where its
// confidence/coverage normally live, how it fails, what approximations it
// makes, and its shadow status. Cards are version-controlled with the
// algorithm and snapshot-tested so an unreviewed change fails CI.
// `shadow_status` defaults to `shadow` and only the WS-H.1.2e promotion
// gate may advance it — the schema cannot express an enforcement grant.

import { z } from 'zod';
import { INVARIANT_TYPE_NAMES } from '../types.js';

export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const SHADOW_STATUSES = ['shadow', 'soft_constraint', 'hard_constraint'] as const;
export type ShadowStatus = (typeof SHADOW_STATUSES)[number];

const nonEmpty = z.string().min(1);

export const failureModeSchema = z
  .object({
    mode: nonEmpty,
    impact: nonEmpty,
    mitigation: nonEmpty,
  })
  .strict();

export const invariantCardSchema = z
  .object({
    invariant_type: z.enum(INVARIANT_TYPE_NAMES),
    owner: nonEmpty,
    version: z.string().regex(SEMVER_PATTERN, 'version must be semver (major.minor.patch)'),
    /** Reference describing expected inputs (doc path or schema name). */
    input_schema: nonEmpty,
    /** Reference describing the score_vector structure. */
    output_schema: nonEmpty,
    confidence_bounds: z
      .object({
        min: z.number().min(0).max(1),
        typical: z.number().min(0).max(1),
        max: z.number().min(0).max(1),
      })
      .strict()
      .refine((b) => b.min <= b.typical && b.typical <= b.max, {
        message: 'confidence bounds must satisfy min <= typical <= max',
      }),
    coverage_bounds: z
      .object({
        min_acceptable: z.number().min(0).max(1),
        typical: z.number().min(0).max(1),
      })
      .strict()
      .refine((b) => b.min_acceptable <= b.typical, {
        message: 'coverage bounds must satisfy min_acceptable <= typical',
      }),
    /** What counts toward coverage (the WS-H.1.1c convention). */
    coverage_definition: nonEmpty,
    known_failure_modes: z.array(failureModeSchema).min(1),
    fallback_behavior: nonEmpty,
    /** Non-empty for invariants using approximations; empty string allowed
     *  ONLY for exact methods (enforced per-card by tests). */
    approximation_notes: z.string(),
    shadow_status: z.enum(SHADOW_STATUSES).default('shadow'),
    dependencies: z.array(nonEmpty),
  })
  .strict();

export type InvariantCard = z.infer<typeof invariantCardSchema>;
