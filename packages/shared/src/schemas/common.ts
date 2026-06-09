// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared primitive schemas reused across feed, thread, room, profile, signal,
// and attention contracts. Keeping the primitives in one place means the client
// (zod-on-response, WS-C.1.2/6.12.7) and the server validate identically — a
// single source of truth for the wire shapes that cross the trust boundary.
import { z } from 'zod';

/** A v4 UUID identifier (stories, threads, rooms, users, aggregates). */
export const uuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof uuidSchema>;

/** ISO-8601 timestamp string (the wire format for all `*_at` fields). */
export const isoTimestampSchema = z.string().datetime();
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

/**
 * An http(s) URL. `z.string().url()` alone accepts script-bearing schemes
 * (`javascript`, `data`, `vbscript`), which must never enter the cache and reach a
 * renderer/href (XSS). This narrows the trust boundary to web URLs only — defence
 * in depth with the reader's own sandbox + the strict CSP.
 */
export const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'URL must be http(s)' });

/**
 * Cursor for keyset pagination. Opaque to the client — it is echoed back to the
 * server verbatim, never parsed or constructed locally.
 */
export const cursorSchema = z.string().min(1).max(512);

/** Standard paginated envelope: a typed page plus an optional next cursor. */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: cursorSchema.nullable(),
  });
}

/**
 * Normalised API error shape. Every BFF error response is validated to this so
 * the client renders a typed {@link import('../index.js')} ErrorState rather
 * than leaking a raw server payload (WS-C.3.1 interceptor → WS-B.2.5).
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    /** Optional field-level details for form validation surfaces. */
    details: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Minimal acknowledgement for state-changing endpoints with no body to return. */
export const okAckSchema = z.object({ ok: z.boolean() });
export type OkAck = z.infer<typeof okAckSchema>;
