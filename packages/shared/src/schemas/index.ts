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
export * from './claim.js';
export * from './common.js';
export * from './compliance-api.js';
export * from './contribution.js';
export * from './debate.js';
export * from './dev-simulator.js';
export * from './events/index.js';
export * from './feature-flags.js';
export * from './feed.js';
export * from './forum-api.js';
export * from './governance-api.js';
export * from './identity-records.js';
export * from './invariants-api.js';
export * from './jurisdiction.js';
export * from './knomosis-api.js';
export * from './migration-api.js';
export * from './moderation-api.js';
export * from './moderation-console-api.js';
export * from './notifications.js';
export * from './privacy-api.js';
export * from './privacy-settings.js';
export * from './profile.js';
export * from './room.js';
export * from './search.js';
export * from './signal-ledger.js';
export * from './source.js';
export * from './steward-roles.js';
export * from './story.js';
export * from './takedown.js';
export * from './telemetry.js';
export * from './thread.js';
export * from './treasury-governance-api.js';
export * from './user.js';
export * from './wallet-api.js';
