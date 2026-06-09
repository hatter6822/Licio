// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room contracts (SPEC §16, §23.2 /rooms). Rooms are topic/local communities and
// community lenses; governance lives behind a flag-gated sub-route (WS-C.1.1b).
import { z } from 'zod';
import { isoTimestampSchema, paginatedSchema, uuidSchema } from './common.js';

export const roomKindSchema = z.enum(['topic', 'local', 'lens', 'community']);

export const roomSummarySchema = z.object({
  room_id: uuidSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  kind: roomKindSchema,
  description: z.string().nullable(),
  /** True when the current user has joined/subscribed. */
  joined: z.boolean(),
});
export type RoomSummary = z.infer<typeof roomSummarySchema>;

export const roomDetailSchema = roomSummarySchema.extend({
  created_at: isoTimestampSchema,
  /** Whether room governance is configured (still gated by the crypto/gov flag). */
  governance_available: z.boolean(),
});
export type RoomDetail = z.infer<typeof roomDetailSchema>;

export const roomListResponseSchema = paginatedSchema(roomSummarySchema);
export type RoomListResponse = z.infer<typeof roomListResponseSchema>;
