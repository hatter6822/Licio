// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  timestamp: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './attention.js';
export * from './audit.js';
export * from './auth-api.js';
export * from './common.js';
export * from './contribution.js';
export * from './events/index.js';
export * from './feature-flags.js';
export * from './feed.js';
export * from './identity-records.js';
export * from './notifications.js';
export * from './privacy-api.js';
export * from './privacy-settings.js';
export * from './profile.js';
export * from './room.js';
export * from './signal-ledger.js';
export * from './telemetry.js';
export * from './thread.js';
export * from './user.js';
