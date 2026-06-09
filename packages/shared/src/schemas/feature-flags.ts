// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feature-flag contract (WS-C.1.3c, SPEC §0.5 constraint 10). Crypto and
// governance default to OFF and only ever fail toward OFF. The schema is the
// validation boundary for the server hydration response: a partial or garbled
// response is rejected wholesale and the client keeps its safe defaults.
import { z } from 'zod';

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
});
export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

/**
 * The hard, fail-closed defaults. Every optional capability is off. This object
 * is the value the store starts from and the value it returns to on any error,
 * offline, or partial-response condition.
 */
export const FAIL_CLOSED_FLAGS: FeatureFlags = {
  cryptoEnabled: false,
  governanceEnabled: false,
  regionFlags: {},
};

/**
 * Server hydration response. Validated before it can flip any flag; a parse
 * failure leaves {@link FAIL_CLOSED_FLAGS} in place (WS-C.1.3c "stays false").
 */
export const featureFlagsResponseSchema = featureFlagsSchema;
