// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H public wire contracts (SPEC §10.5, §7.6): the "Where interpretations
// differ" payload + the per-topic repeats preference. Validated with zod
// before entering the TanStack Query cache (WS-C.1.2 boundary defense). The
// surface is DESCRIPTIVE: `needs_context` means interpretations differ —
// never false/bad/banned. (The independent-sources drawer payload was
// removed: comment-centric sourcing superseded story-level lineage as the
// reader-facing surface; MERI remains a ranking/quota input.)
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
  /** Human lens names when resolvable (ids stay the stable keys). */
  lens_a_name: z.string().min(1).max(120).optional(),
  lens_b_name: z.string().min(1).max(120).optional(),
  /** Plain language; neither side is marked correct (WS-H.4.3b). */
  summary: z.string().min(1).max(500),
  disagreement: z.number().min(0).max(1),
});
export type StoryInterpretation = z.infer<typeof storyInterpretationSchema>;

export const storyInterpretationsResponseSchema = z.object({
  story_id: uuidSchema,
  context_state: z.enum(SCOI_CONTEXT_STATES_WIRE).nullable(),
  interpretations: z.array(storyInterpretationSchema).max(16),
  /** "Needs Context" label gate (WS-H.4.3a). */
  needs_context: z.boolean(),
});
export type StoryInterpretationsResponse = z.infer<typeof storyInterpretationsResponseSchema>;

/** Per-topic repeats preference (SPEC §7.6; WS-H.2.3c). */
export const TOPIC_REPEAT_PREFERENCES = ['fewer_repeats', 'balanced', 'show_all'] as const;
export type TopicRepeatPreference = (typeof TOPIC_REPEAT_PREFERENCES)[number];
export const topicRepeatPreferenceSchema = z.enum(TOPIC_REPEAT_PREFERENCES);
