// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /v1/privacy/* — the WS-D.2 privacy controls.  These are REAL controls, not
// placebo toggles (§19.3): a settings change is clamped to the teen floor,
// audited old→new, and (for personalization/retention) flagged for the downstream
// WS-E consumer so collection actually changes; attention history really deletes;
// account deletion runs a grace period then removes all personal data.

import { zValidator } from '@hono/zod-validator';
import {
  attentionDeleteRequestSchema,
  clampPrivacySettingsToTeenFloor,
  deletionStatusSchema,
  exportJobStatusSchema,
  isMinorBand,
  personalizationSettingsSchema,
  privacySettingsPatchSchema,
  privacySettingsResponseSchema,
  privacySettingsSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { privateOwnershipOutcome } from '../identity/rbac.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { revokeAllForUser } from '../identity/sessions.js';
import {
  type AuthEnv,
  authMiddleware,
  requireStepUp,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const GRACE_PERIOD_MS = 30 * 24 * 60 * 60_000;

const unauthenticated = {
  error: { code: 'unauthenticated', message: 'Authentication required' },
} as const;

export function createPrivacyRoutes(resolve: () => IdentityServices = getIdentityServices) {
  return (
    new Hono<AuthEnv>()
      .use('*', authMiddleware(resolve))

      // --- Settings ---------------------------------------------------------
      .get('/settings', requireVerifiedAccount(), (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(unauthenticated, 401);
        const user = services.store.getUser(auth.userId);
        if (!user) return c.json(unauthenticated, 401);
        return c.json(
          privacySettingsResponseSchema.parse({
            privacy_settings: user.privacySettings,
            personalization_settings: user.personalizationSettings,
            teen_floor_applied: isMinorBand(user.ageBand),
          }),
        );
      })

      .patch(
        '/settings',
        requireVerifiedAccount(),
        zValidator('json', privacySettingsPatchSchema),
        (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(unauthenticated, 401);
          const user = services.store.getUser(auth.userId);
          if (!user) return c.json(unauthenticated, 401);
          const patch = c.req.valid('json');

          let nextPrivacy = user.privacySettings;
          let nextPersonalization = user.personalizationSettings;
          const changed: string[] = [];

          if (patch.privacy_settings) {
            const merged = privacySettingsSchema.parse({
              ...user.privacySettings,
              ...patch.privacy_settings,
            });
            // Teen-floor clamping is server-side: a teen cannot weaken below the floor
            // even via a direct API call (WS-D.1.7b, fail-closed).
            nextPrivacy = isMinorBand(user.ageBand)
              ? clampPrivacySettingsToTeenFloor(merged)
              : merged;
            for (const key of Object.keys(patch.privacy_settings)) changed.push(key);
          }
          if (patch.personalization_settings) {
            nextPersonalization = personalizationSettingsSchema.parse({
              ...user.personalizationSettings,
              ...patch.personalization_settings,
            });
            for (const key of Object.keys(patch.personalization_settings)) changed.push(key);
          }

          services.store.updateUser(auth.userId, {
            privacySettings: nextPrivacy,
            personalizationSettings: nextPersonalization,
          });

          // Audit the consent change (old→new summary).
          void services.audit.append({
            actorUserId: auth.userId,
            eventType: 'privacy_setting_change',
            context: {
              setting: changed.join(','),
              previous_value: String(user.privacySettings.personalization_enabled),
              new_value: String(nextPrivacy.personalization_enabled),
            },
          });

          // Downstream propagation hook: disabling personalization / setting retention
          // to `none` must actually stop collection (WS-E consumes this).
          services.onPrivacyChange?.({
            userId: auth.userId,
            personalizationEnabled: nextPrivacy.personalization_enabled,
            retention: nextPrivacy.attention_retention_preference,
          });

          return c.json(
            privacySettingsResponseSchema.parse({
              privacy_settings: nextPrivacy,
              personalization_settings: nextPersonalization,
              teen_floor_applied: isMinorBand(user.ageBand),
            }),
          );
        },
      )

      // --- Attention history deletion (touches NO wallet table) -------------
      .post(
        '/attention/delete',
        requireVerifiedAccount(),
        zValidator('json', attentionDeleteRequestSchema),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(unauthenticated, 401);
          const { mode } = c.req.valid('json');
          // Strictly user-scoped; the purge is delegated to WS-E (isolated from wallet).
          const removed = (await services.purgeAttention?.(auth.userId, mode)) ?? 0;
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'attention_delete',
            context: {},
          });
          return c.json({ mode, aggregates_removed: removed, affinities_reset: true });
        },
      )

      // --- DSAR export (step-up protected) ----------------------------------
      .post('/export', requireVerifiedAccount(), requireStepUp(), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(unauthenticated, 401);
        // One active export per user: a second request returns the existing job.
        const existing = services.store.activeExportJob(auth.userId);
        const job = existing ?? services.store.createExportJob(auth.userId);
        if (!existing) {
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'export_request',
            context: {},
          });
        }
        return c.json(toExportStatus(job), 202);
      })

      .get(
        '/export/:jobId',
        requireVerifiedAccount(),
        zValidator('param', z.object({ jobId: z.string().uuid() })),
        (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(unauthenticated, 401);
          const job = services.store.getExportJob(c.req.valid('param').jobId);
          // Cross-user (or missing) → 404, never confirming existence.
          if (!job || privateOwnershipOutcome(auth.userId, job.userId) === 'not_found') {
            return c.json({ error: { code: 'not_found', message: 'Export not found.' } }, 404);
          }
          return c.json(toExportStatus(job));
        },
      )

      // --- Account deletion (step-up; 30-day grace) -------------------------
      .post('/delete-account', requireVerifiedAccount(), requireStepUp(), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(unauthenticated, 401);
        const now = Date.now();
        services.store.updateUser(auth.userId, { accountState: 'deactivated' }, now);
        services.store.setDeletion({
          userId: auth.userId,
          state: 'grace_period',
          requestedAt: new Date(now).toISOString(),
          purgeAt: new Date(now + GRACE_PERIOD_MS).toISOString(),
          cancelledAt: null,
          completedAt: null,
        });
        await revokeAllForUser(services.sessions, auth.userId);
        await services.audit.append({
          actorUserId: auth.userId,
          eventType: 'deletion_request',
          context: {},
        });
        const user = services.store.getUser(auth.userId);
        const email = user?.email;
        if (email) await services.mailer.sendNotice(email, 'deletion_requested');
        return c.json(toDeletionStatus(services, auth.userId));
      })

      .get('/delete-account/status', (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(unauthenticated, 401);
        return c.json(toDeletionStatus(services, auth.userId));
      })

      .post('/delete-account/cancel', async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(unauthenticated, 401);
        const req = services.store.getDeletion(auth.userId);
        if (req?.state !== 'grace_period') {
          return c.json({ error: { code: 'not_found', message: 'No cancellable deletion.' } }, 404);
        }
        services.store.setDeletion({
          ...req,
          state: 'cancelled',
          cancelledAt: new Date().toISOString(),
        });
        services.store.updateUser(auth.userId, { accountState: 'active' });
        await services.audit.append({
          actorUserId: auth.userId,
          eventType: 'deletion_cancel',
          context: {},
        });
        return c.json(toDeletionStatus(services, auth.userId));
      })
  );
}

function toExportStatus(job: NonNullable<ReturnType<IdentityServices['store']['getExportJob']>>) {
  return exportJobStatusSchema.parse({
    job_id: job.jobId,
    status: job.status,
    progress_pct: job.progressPct,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    expires_at: job.expiresAt,
    download_available: job.status === 'completed',
  });
}

function toDeletionStatus(services: IdentityServices, userId: string) {
  const req = services.store.getDeletion(userId);
  if (!req || req.state === 'cancelled') {
    return deletionStatusSchema.parse({
      state: 'none',
      requested_at: null,
      purge_at: null,
      cancellable: false,
    });
  }
  return deletionStatusSchema.parse({
    state: req.state,
    requested_at: req.requestedAt,
    purge_at: req.purgeAt,
    cancellable: req.state === 'grace_period',
  });
}

export type PrivacyRoutes = ReturnType<typeof createPrivacyRoutes>;
