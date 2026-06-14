// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feature-flag contract (WS-C.1.3c, SPEC §0.5 constraint 10). Crypto and
// governance default to OFF and only ever fail toward OFF. The schema is the
// validation boundary for the server hydration response: a partial or garbled
// response is rejected wholesale and the client keeps its safe defaults.
import { z } from 'zod';

/**
 * WS-Q.6.2 — the content-room rollout surface the client reads to gate the
 * user-visible WS-Q controls. The flags fail closed (OFF ⇒ pre-WS-Q behavior);
 * the caps mirror `ingestion.video_max_*` so the composer's pre-checks match the
 * server (the server remains authoritative). Containment is NEVER represented
 * here — there is no flag that could weaken the read bar or distribution gate.
 */
export const contentSurfaceSchema = z.object({
  media_posts_enabled: z.boolean(),
  in_room_visibility_enabled: z.boolean(),
  binary_visibility_ui: z.boolean(),
  video_max_bytes: z.number().int().positive(),
  video_max_seconds: z.number().int().positive(),
});
export type ContentSurface = z.infer<typeof contentSurfaceSchema>;

/** The hard video ceiling (mirrors the DB CHECK / shared MAX_VIDEO_BYTES). */
const HARD_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Resolved flag set. `regionFlags` carries jurisdiction-specific availability
 * keyed by an opaque flag name; an absent key is treated as `false` by readers.
 */
export const featureFlagsSchema = z.object({
  /** Knomosis / wallet plane. MUST default false (SPEC §0.5 constraint 10). */
  cryptoEnabled: z.boolean(),
  /** Room governance plane. Defaults false. */
  governanceEnabled: z.boolean(),
  /** Per-region/jurisdiction flags; absent ⇒ false. */
  regionFlags: z.record(z.string(), z.boolean()),
  /** WS-Q content-room rollout surface (flags + video caps). */
  content: contentSurfaceSchema,
});
export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

/**
 * The hard, fail-closed defaults. Every optional capability is off. This object
 * is the value the store starts from and the value it returns to on any error,
 * offline, or partial-response condition. The content flags fail to OFF
 * (pre-WS-Q); the caps fail to the hard ceiling (a safe upper bound for the
 * client pre-check — the server still enforces the tunable value).
 */
export const FAIL_CLOSED_FLAGS: FeatureFlags = {
  cryptoEnabled: false,
  governanceEnabled: false,
  regionFlags: {},
  content: {
    media_posts_enabled: false,
    in_room_visibility_enabled: false,
    binary_visibility_ui: false,
    video_max_bytes: HARD_VIDEO_MAX_BYTES,
    video_max_seconds: 600,
  },
};

/**
 * Server hydration response. Validated before it can flip any flag; a parse
 * failure leaves {@link FAIL_CLOSED_FLAGS} in place (WS-C.1.3c "stays false").
 */
export const featureFlagsResponseSchema = featureFlagsSchema;
