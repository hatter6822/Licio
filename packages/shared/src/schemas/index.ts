// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  timestamp: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './attention.js';
export * from './common.js';
export * from './contribution.js';
export * from './feature-flags.js';
export * from './feed.js';
export * from './notifications.js';
export * from './profile.js';
export * from './room.js';
export * from './signal-ledger.js';
export * from './thread.js';
