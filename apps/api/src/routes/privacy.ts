// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /v1/privacy/* — the WS-D.2 privacy controls.  REAL controls, not placebo
// toggles (§19.3): settings changes are clamped to the teen floor, audited
// old→new, and propagated downstream so collection actually changes; attention
// history really deletes; DSAR export assembles → encrypts → serves via a signed,
// step-up-protected, expiring URL; account deletion runs a 30-day grace period
// (cancellable by a remaining-method re-login OR an emailed token) then hard-purges.

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
import { randomToken } from '../identity/crypto.js';
import { verifyDownloadToken } from '../identity/object-store.js';
import {
  exportObjectKey,
  mintExportDownloadToken,
  processExportJob,
} from '../identity/privacy-jobs.js';
import { privateOwnershipOutcome } from '../identity/rbac.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, revokeAllForUser, validateSession } from '../identity/sessions.js';
import {
  type AuthEnv,
  authMiddleware,
  requireStepUp,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const GRACE_PERIOD_MS = 30 * 24 * 60 * 60_000;
const cancelTokenKey = (token: string) => `delcancel:${token}`;
const u = { error: { code: 'unauthenticated', message: 'Authentication required' } } as const;

export function createPrivacyRoutes(resolve: () => IdentityServices = getIdentityServices) {
  return (
    new Hono<AuthEnv>()
      // --- Settings ---------------------------------------------------------
      .get('/settings', authMiddleware(resolve), requireVerifiedAccount(), (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(u, 401);
        const user = services.store.getUser(auth.userId);
        if (!user) return c.json(u, 401);
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
        authMiddleware(resolve),
        requireVerifiedAccount(),
        zValidator('json', privacySettingsPatchSchema),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(u, 401);
          const user = services.store.getUser(auth.userId);
          if (!user) return c.json(u, 401);
          const patch = c.req.valid('json');

          let nextPrivacy = user.privacySettings;
          let nextPersonalization = user.personalizationSettings;
          const changed: string[] = [];

          if (patch.privacy_settings) {
            const merged = privacySettingsSchema.parse({
              ...user.privacySettings,
              ...patch.privacy_settings,
            });
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
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'privacy_setting_change',
            context: {
              setting: changed.join(','),
              previous_value: String(user.privacySettings.personalization_enabled),
              new_value: String(nextPrivacy.personalization_enabled),
            },
          });
          // Disabling personalization / retention=none must actually stop collection.
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
        authMiddleware(resolve),
        requireVerifiedAccount(),
        zValidator('json', attentionDeleteRequestSchema),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(u, 401);
          const { mode } = c.req.valid('json');
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
      .post(
        '/export',
        authMiddleware(resolve),
        requireVerifiedAccount(),
        requireStepUp(),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(u, 401);
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
          return c.json(await toExportStatus(services, job, auth.userId), 202);
        },
      )

      .get(
        '/export/:jobId',
        authMiddleware(resolve),
        requireVerifiedAccount(),
        zValidator('param', z.object({ jobId: z.string().uuid() })),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(u, 401);
          let job = services.store.getExportJob(c.req.valid('param').jobId);
          if (!job || privateOwnershipOutcome(auth.userId, job.userId) === 'not_found') {
            return c.json({ error: { code: 'not_found', message: 'Export not found.' } }, 404);
          }
          // In-process worker substitute: a queued job is assembled on first poll.
          if (job.status === 'queued') {
            await processExportJob(services, job.jobId);
            job = services.store.getExportJob(job.jobId) ?? job;
          }
          return c.json(await toExportStatus(services, job, auth.userId));
        },
      )

      // --- Export download (session + fresh step-up + signed token) ---------
      .get(
        '/export/:jobId/download',
        authMiddleware(resolve),
        requireVerifiedAccount(),
        requireStepUp(),
        zValidator('param', z.object({ jobId: z.string().uuid() })),
        zValidator('query', z.object({ t: z.string().min(1) })),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(u, 401);
          const { jobId } = c.req.valid('param');
          const job = services.store.getExportJob(jobId);
          if (!job || privateOwnershipOutcome(auth.userId, job.userId) === 'not_found') {
            return c.json({ error: { code: 'not_found', message: 'Export not found.' } }, 404);
          }
          const ok = verifyDownloadToken(
            services.config.masterSecret,
            c.req.valid('query').t,
            jobId,
            auth.userId,
            Date.now(),
          );
          if (!ok || job.status !== 'completed') {
            return c.json(
              { error: { code: 'invalid_link', message: 'Download link invalid or expired.' } },
              403,
            );
          }
          const obj = await services.objectStore.get(exportObjectKey(jobId));
          if (!obj)
            return c.json({ error: { code: 'gone', message: 'Export no longer available.' } }, 410);
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'export_download',
            context: {},
          });
          // Return a plain `Response` (not `c.body`) so the handler's inferred
          // return type stays portable (avoids a TS2883 reference to Hono's
          // internal `Data` type) and the decrypted bytes stream verbatim.
          return new Response(Uint8Array.from(obj.bytes), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Content-Disposition': 'attachment; filename="licio-export.json"',
            },
          });
        },
      )

      // --- Account deletion (step-up; 30-day grace) -------------------------
      .post(
        '/delete-account',
        authMiddleware(resolve),
        requireVerifiedAccount(),
        requireStepUp(),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(u, 401);
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
          // A single-use cancellation token (for the emailed link); also cancellable
          // by re-login for accounts with no email on file.
          const token = randomToken(24);
          await services.otp.set(cancelTokenKey(token), auth.userId, GRACE_PERIOD_MS);
          await revokeAllForUser(services.sessions, auth.userId);
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'deletion_request',
            context: {},
          });
          const email = services.store.getUser(auth.userId)?.email;
          if (email)
            await services.mailer.sendNotice(email, 'deletion_requested', { cancel_token: token });
          c.header('Set-Cookie', clearSidCookie(), { append: true });
          return c.json(toDeletionStatus(services, auth.userId));
        },
      )

      .get(
        '/delete-account/status',
        authMiddleware(resolve, { allowDeletionPending: true }),
        (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(u, 401);
          return c.json(toDeletionStatus(services, auth.userId));
        },
      )

      // Cancel via an emailed TOKEN (unauthenticated) OR a remaining-method
      // re-login.  The body is parsed defensively: a session-based cancel sends
      // no body at all, so an empty/invalid body must NOT 400 — it falls through
      // to the session path.
      .post('/delete-account/cancel', async (c) => {
        const services = resolve();
        const token = await readCancelToken(c);
        let userId: string | null = null;
        if (token) {
          userId = await services.otp.take(cancelTokenKey(token));
        } else {
          const sessionToken = readSessionToken(c.req.header('cookie'));
          const validated = sessionToken
            ? await validateSession(services.sessions, sessionToken)
            : null;
          userId = validated?.record.user_id ?? null;
        }
        if (!userId) {
          return c.json({ error: { code: 'not_found', message: 'No cancellable deletion.' } }, 404);
        }
        const req = services.store.getDeletion(userId);
        if (req?.state !== 'grace_period') {
          return c.json({ error: { code: 'not_found', message: 'No cancellable deletion.' } }, 404);
        }
        services.store.setDeletion({
          ...req,
          state: 'cancelled',
          cancelledAt: new Date().toISOString(),
        });
        services.store.updateUser(userId, { accountState: 'active' });
        await services.audit.append({
          actorUserId: userId,
          eventType: 'deletion_cancel',
          context: {},
        });
        return c.json(toDeletionStatus(services, userId));
      })
  );
}

function clearSidCookie(): string {
  return '__Host-sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
}

/**
 * Read an optional cancellation token from the request body without ever
 * throwing: an empty body (the session-based cancel) or a malformed one yields
 * `undefined` rather than a 400, so the handler can fall through to the session
 * path.
 */
async function readCancelToken(c: {
  req: { json: () => Promise<unknown> };
}): Promise<string | undefined> {
  try {
    const raw: unknown = await c.req.json();
    if (raw && typeof raw === 'object' && 'token' in raw) {
      const value = (raw as { token?: unknown }).token;
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    // No body / not JSON → session-based cancel.
  }
  return undefined;
}

async function toExportStatus(
  services: IdentityServices,
  job: NonNullable<ReturnType<IdentityServices['store']['getExportJob']>>,
  userId: string,
) {
  const available = job.status === 'completed';
  return exportJobStatusSchema.parse({
    job_id: job.jobId,
    status: job.status,
    progress_pct: job.progressPct,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    expires_at: job.expiresAt,
    download_available: available,
    // A FRESH signed token is minted per request, never persisted (WS-D.2.2c).
    download_token: available ? mintExportDownloadToken(services, job.jobId, userId) : null,
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
