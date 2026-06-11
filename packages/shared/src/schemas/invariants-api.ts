// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H public wire contracts (SPEC §10.5, §7.6): the "Where interpretations
// differ" payload and the independent-sources drawer payload. Validated with
// zod before entering the TanStack Query cache (WS-C.1.2 boundary defense).
// Both surfaces are DESCRIPTIVE: `needs_context` means interpretations
// differ — never false/bad/banned — and no exposure label implies that
// repetition equals truth.
import { z } from 'zod';
import { uuidSchema } from './common.js';

/** SCOI context states (SPEC §10.4). */
export const SCOI_CONTEXT_STATES_WIRE = [
  'coherent',
  'ambiguous',
  'split',
  'obstructed',
  'weaponized',
] as const;

export const storyInterpretationSchema = z.object({
  lens_a: z.string().min(1).max(128),
  lens_b: z.string().min(1).max(128),
  /** Plain language; neither side is marked correct (WS-H.4.3b). */
  summary: z.string().min(1).max(500),
  disagreement: z.number().min(0).max(1),
});

export const storyInterpretationsResponseSchema = z.object({
  story_id: uuidSchema,
  context_state: z.enum(SCOI_CONTEXT_STATES_WIRE).nullable(),
  interpretations: z.array(storyInterpretationSchema).max(16),
  /** "Needs Context" label gate (WS-H.4.3a). */
  needs_context: z.boolean(),
});
export type StoryInterpretationsResponse = z.infer<typeof storyInterpretationsResponseSchema>;

/** MERI exposure labels (SPEC §7.6; WS-H.2.3a). */
export const MERI_EXPOSURE_LABELS_WIRE = [
  'independent_source',
  'new_angle',
  'same_claim_new_evidence',
  'duplicate_context',
] as const;
export type MeriExposureLabelWire = (typeof MERI_EXPOSURE_LABELS_WIRE)[number];

export const independentSourcesResponseSchema = z.object({
  story_id: uuidSchema,
  /** Null until the first MERI shadow run covers the story (honest absence). */
  marginal_gain: z.number().min(0).nullable(),
  exposure_label: z.enum(MERI_EXPOSURE_LABELS_WIRE).nullable(),
  redundancy_classes: z.number().int().nonnegative(),
  source: z
    .object({
      name: z.string().min(1).max(200),
      publisher_lineage: z.array(z.string().min(1).max(200)).max(10),
    })
    .nullable(),
  confirmed_syndication_count: z.number().int().nonnegative(),
});
export type IndependentSourcesResponse = z.infer<typeof independentSourcesResponseSchema>;

/** Per-topic repeats preference (SPEC §7.6; WS-H.2.3c). */
export const TOPIC_REPEAT_PREFERENCES = ['fewer_repeats', 'balanced', 'show_all'] as const;
export type TopicRepeatPreference = (typeof TOPIC_REPEAT_PREFERENCES)[number];
export const topicRepeatPreferenceSchema = z.enum(TOPIC_REPEAT_PREFERENCES);
