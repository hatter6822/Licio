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
  legacyPreservingFeedMode,
  personalizationSettingsSchema,
  privacySettingsPatchSchema,
  privacySettingsResponseSchema,
  privacySettingsSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { emitPrivacyRequestEvent } from '../events/privacy-events.js';
import { getEventPipelineServices } from '../events/services.js';
import { randomToken, sha256Hex } from '../identity/crypto.js';
import { verifyDownloadToken } from '../identity/object-store.js';
import {
  exportObjectKey,
  mintExportDownloadToken,
  processExportJob,
} from '../identity/privacy-jobs.js';
import { privateOwnershipOutcome } from '../identity/rbac.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, revokeAllForUser, validateSession } from '../identity/sessions.js';
import { rateLimit } from '../lib/rate-limit.js';
import {
  type AuthEnv,
  authMiddleware,
  requireStepUp,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const GRACE_PERIOD_MS = 30 * 24 * 60 * 60_000;
const cancelTokenKey = (token: string) => `delcancel:${sha256Hex(token)}`;
const u = { error: { code: 'unauthenticated', message: 'Authentication required' } } as const;

export function createPrivacyRoutes(resolve: () => IdentityServices = getIdentityServices) {
  return (
    new Hono<AuthEnv>()
      // --- Settings ---------------------------------------------------------
      .get('/settings', authMiddleware(resolve), requireVerifiedAccount(), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(u, 401);
        const user = await services.store.getUser(auth.userId);
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
          const user = await services.store.getUser(auth.userId);
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
            // Feed-mode writes store the legacy-preserving spelling (rollout
            // compat: stale bundles on the same account keep parsing the
            // echoed value; lossless for best/new — see
            // legacyPreservingFeedMode).
            nextPersonalization = personalizationSettingsSchema.parse({
              ...user.personalizationSettings,
              ...patch.personalization_settings,
              ...(patch.personalization_settings.feed_mode !== undefined
                ? { feed_mode: legacyPreservingFeedMode(patch.personalization_settings.feed_mode) }
                : {}),
            });
            for (const key of Object.keys(patch.personalization_settings)) changed.push(key);
          }

          await services.store.updateUser(auth.userId, {
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
          // WS-E.1.1e producer: the privacy pipeline observes the request.
          await emitPrivacyRequestEvent(
            getEventPipelineServices(),
            'attention_reset',
            auth.userId,
            'completed',
          );
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
          const existing = await services.store.activeExportJob(auth.userId);
          const job = existing ?? (await services.store.createExportJob(auth.userId));
          if (!existing) {
            await services.audit.append({
              actorUserId: auth.userId,
              eventType: 'export_request',
              context: {},
            });
            await emitPrivacyRequestEvent(
              getEventPipelineServices(),
              'export',
              auth.userId,
              'received',
            );
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
          let job = await services.store.getExportJob(c.req.valid('param').jobId);
          if (!job || privateOwnershipOutcome(auth.userId, job.userId) === 'not_found') {
            return c.json({ error: { code: 'not_found', message: 'Export not found.' } }, 404);
          }
          // In-process worker substitute: a queued job is assembled on first poll.
          if (job.status === 'queued') {
            await processExportJob(services, job.jobId);
            job = (await services.store.getExportJob(job.jobId)) ?? job;
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
          const job = await services.store.getExportJob(jobId);
          if (!job || privateOwnershipOutcome(auth.userId, job.userId) === 'not_found') {
            return c.json({ error: { code: 'not_found', message: 'Export not found.' } }, 404);
          }
          const now = Date.now();
          const ok = verifyDownloadToken(
            services.config.masterSecret,
            c.req.valid('query').t,
            jobId,
            auth.userId,
            now,
          );
          if (!ok || job.status !== 'completed') {
            return c.json(
              { error: { code: 'invalid_link', message: 'Download link invalid or expired.' } },
              403,
            );
          }
          // The 72-hour archive window is enforced HERE too (not only by the
          // sweeper): a job past its expiry is gone even if the sweep has not run.
          if (job.expiresAt && Date.parse(job.expiresAt) <= now) {
            return c.json({ error: { code: 'gone', message: 'Export no longer available.' } }, 410);
          }
          const obj = await services.objectStore.get(exportObjectKey(jobId), now);
          if (!obj)
            return c.json({ error: { code: 'gone', message: 'Export no longer available.' } }, 410);
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'export_download',
            context: {},
          });
          // Return a plain `Response` (not `c.body`) so the handler's inferred
          // return type stays portable (avoids a TS2883 reference to Hono's
          // internal `Data` type) and the decrypted bytes stream verbatim.  The
          // archive is a concentrated PII bundle: never cached anywhere.
          return new Response(Uint8Array.from(obj.bytes), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Content-Disposition': 'attachment; filename="licio-export.json"',
              'Cache-Control': 'no-store',
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
          await services.store.updateUser(auth.userId, { accountState: 'deactivated' }, now);
          await services.store.setDeletion({
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
          await emitPrivacyRequestEvent(
            getEventPipelineServices(),
            'deletion',
            auth.userId,
            'received',
          );
          // A single-use cancellation token for the emailed link — minted ONLY
          // when an email exists (no orphaned 30-day secret otherwise).  A
          // no-email account cancels by re-logging in with a remaining method.
          const email = (await services.store.getUser(auth.userId))?.email;
          if (email) {
            const token = randomToken(24);
            await services.otp.set(cancelTokenKey(token), auth.userId, GRACE_PERIOD_MS);
            await services.mailer.sendNotice(email, 'deletion_requested', { cancel_token: token });
          }
          c.header('Set-Cookie', clearSidCookie(), { append: true });
          return c.json(await toDeletionStatus(services, auth.userId));
        },
      )

      .get(
        '/delete-account/status',
        authMiddleware(resolve, { allowDeletionPending: true }),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(u, 401);
          return c.json(await toDeletionStatus(services, auth.userId));
        },
      )

      // Cancel via an emailed TOKEN (unauthenticated) OR a remaining-method
      // re-login.  The body is parsed defensively: a session-based cancel sends
      // no body at all, so an empty/invalid body must NOT 400 — it falls through
      // to the session path.  Unauthenticated + token-bearing ⇒ a GLOBAL
      // identity-free budget bounds flooding (the 192-bit token is unguessable;
      // nothing about the requester is read, §19.1).
      .post('/delete-account/cancel', rateLimit({ limit: 60, windowMs: 60_000 }), async (c) => {
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
        const req = await services.store.getDeletion(userId);
        if (req?.state !== 'grace_period') {
          return c.json({ error: { code: 'not_found', message: 'No cancellable deletion.' } }, 404);
        }
        await services.store.setDeletion({
          ...req,
          state: 'cancelled',
          cancelledAt: new Date().toISOString(),
        });
        await services.store.updateUser(userId, { accountState: 'active' });
        await services.audit.append({
          actorUserId: userId,
          eventType: 'deletion_cancel',
          context: {},
        });
        await emitPrivacyRequestEvent(getEventPipelineServices(), 'deletion', userId, 'cancelled');
        return c.json(await toDeletionStatus(services, userId));
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
  job: NonNullable<Awaited<ReturnType<IdentityServices['store']['getExportJob']>>>,
  userId: string,
  now: number = Date.now(),
) {
  // Available only while completed AND inside the 72-hour window — the read
  // path never advertises (or signs a token for) an archive past its expiry,
  // independent of whether the sweeper has run (WS-D.2.2c).
  const available =
    job.status === 'completed' && (!job.expiresAt || Date.parse(job.expiresAt) > now);
  return exportJobStatusSchema.parse({
    job_id: job.jobId,
    status: job.status,
    progress_pct: job.progressPct,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    expires_at: job.expiresAt,
    download_available: available,
    // A FRESH signed token is minted per request, never persisted (WS-D.2.2c).
    download_token: available
      ? await mintExportDownloadToken(services, job.jobId, userId, now)
      : null,
  });
}

async function toDeletionStatus(services: IdentityServices, userId: string) {
  const req = await services.store.getDeletion(userId);
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
