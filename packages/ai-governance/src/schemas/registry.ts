// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Model registry records (WS-K.1.1b, SPEC §24.2). The registry wraps each model
// card with its deployment lifecycle. The deployment gate — enforced by the
// registry service (../../apps/api ai-governance/registry.ts) — is the single
// chokepoint: no model reaches `deployed` without a card, passing evaluations,
// and a resolved risk assessment. Old versions are preserved, never overwritten;
// a deprecated version stays queryable for audit but warns on lookup.
import { z } from 'zod';
import { proseSchema, semverSchema, shortTextSchema } from './common.js';
import { modelCardSchema } from './model-card.js';

export const MODEL_STATUSES = ['registered', 'deployed', 'deprecated'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];
export const modelStatusSchema = z.enum(MODEL_STATUSES);

/** Deprecation metadata (WS-K.1.1b): reason + recommended replacement. */
export const deprecationInfoSchema = z
  .object({
    reason: proseSchema,
    /** The version to migrate to, or null if none yet. */
    recommended_replacement: semverSchema.nullable(),
    deprecated_at: z.string().datetime(),
  })
  .strict();
export type DeprecationInfo = z.infer<typeof deprecationInfoSchema>;

export const registeredModelSchema = z
  .object({
    name: shortTextSchema,
    version: semverSchema,
    card: modelCardSchema,
    status: modelStatusSchema,
    deprecation: deprecationInfoSchema.nullable(),
    registered_at: z.string().datetime(),
    /** Set when the version was promoted to production (passed the gate). */
    deployed_at: z.string().datetime().nullable(),
  })
  .strict()
  .refine((m) => m.name === m.card.name && m.version === m.card.version, {
    message: 'registry name/version must match the embedded card',
  })
  .refine((m) => (m.status === 'deprecated') === (m.deprecation !== null), {
    message: 'deprecation metadata is present exactly when status is deprecated',
    path: ['deprecation'],
  })
  .refine((m) => m.status !== 'deployed' || m.deployed_at !== null, {
    message: 'a deployed model must carry a deployed_at timestamp',
    path: ['deployed_at'],
  });
export type RegisteredModel = z.infer<typeof registeredModelSchema>;
