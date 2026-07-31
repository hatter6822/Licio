// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F steward admin surface (/v1/ingestion/admin/*), mirroring the WS-E
// events-admin pattern: every route requires an active steward role WITH a
// TOTP-cleared session (requireSteward, WS-D.1.5b), every state change is
// audited, and config writes are validated BEFORE persistence (422 on
// rejection — fail-closed, WS-E house rule). Covered: the ingestion review
// queue (WS-J.2 seam), syndication relationships (WS-F.2.4), source-profile
// editing (WS-F.2.3a, append-mostly corrections), takedown review/actioning
// (WS-F.1.4f), steward lifecycle triggers (WS-F.1.1c), runtime config, and
// the re-embedding/backfill controls (WS-F.3.2f).
import { randomUUID } from 'node:crypto';
import {
  STORY_LIFECYCLE_TRIGGERS,
  sourceCorrectionAppendSchema,
  sourceEditRequestSchema,
  syndicationCreateRequestSchema,
  takedownActionRequestSchema,
  takedownRecordSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { getEventPipelineServices } from '../events/services.js';
import { getIdentityServices } from '../identity/services.js';
import {
  INGESTION_CONFIG_KEYS,
  type IngestionRuntimeConfig,
  storeIngestionConfigValue,
  validateIngestionConfigValue,
} from '../ingestion/config.js';
import {
  CONTENT_FLAG_NAMES,
  loadContentFlags,
  setContentFlagByName,
  validateContentFlagValue,
} from '../ingestion/content-flags.js';
import { getBackfillProgress, startBackfill, validateBackfill } from '../ingestion/embeddings.js';
import { applyLifecycleTrigger } from '../ingestion/lifecycle.js';
import { getIngestionServices } from '../ingestion/services.js';
import type { TakedownRecordRow } from '../ingestion/stores.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, getAuth, requireSteward } from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } });

function toTakedownWire(record: TakedownRecordRow) {
  return takedownRecordSchema.parse({
    takedown_id: record.takedownId,
    target_type: record.targetType,
    target_id: record.targetId,
    requester_contact: record.requesterContact,
    legal_basis: record.legalBasis,
    claim_detail: record.claimDetail,
    status: record.status,
    resolution_note: record.resolutionNote,
    actioned_at: record.actionedAt,
    created_at: record.createdAt,
  });
}

export function createIngestionAdminRoutes() {
  return (
    new Hono<AuthEnv>()
      .use('*', authMiddleware(), requireSteward())

      // --- Review queue (WS-J.2 seam) -------------------------------------
      .get(
        '/review',
        zValidator(
          'query',
          z.object({
            status: z.enum(['pending', 'resolved']).optional(),
            kind: z
              .enum([
                'near_duplicate',
                'syndication_candidate',
                'extraction_failure',
                'url_safety_hold',
                'low_confidence_claim',
              ])
              .optional(),
          }),
        ),
        async (c) => {
          const ingestion = getIngestionServices();
          const items = await ingestion.reviewQueue.list(c.req.valid('query'), 100);
          return c.json({ items });
        },
      )
      .post(
        '/review/:reviewId/resolve',
        zValidator('param', z.object({ reviewId: uuidSchema })),
        zValidator(
          'json',
          z
            .object({
              action: z.enum(['allow', 'link_existing', 'merge', 'reject']),
              note: z.string().min(1).max(1_000),
            })
            .strict(),
        ),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const { action, note } = c.req.valid('json');
          const resolved = await ingestion.reviewQueue.resolve(
            c.req.valid('param').reviewId,
            `${action}: ${note}`,
            auth.userId,
            new Date(ingestion.now()).toISOString(),
          );
          if (!resolved) return c.json(deny('not_found', 'Review item not found'), 404);
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'ingestion_review_action',
            targetRef: resolved.reviewId,
            context: { setting: resolved.kind, new_value: action },
          });
          return c.json({ item: resolved });
        },
      )

      // --- Syndication relationships (WS-F.2.4) ---------------------------
      .post('/syndications', zValidator('json', syndicationCreateRequestSchema), async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const ingestion = getIngestionServices();
        const request = c.req.valid('json');
        // Canonicalize to `syndicates_to` (from = origin): a `syndicated_from`
        // input swaps the endpoints, so one relationship has ONE stored edge.
        const [fromId, toId] =
          request.direction === 'syndicates_to'
            ? [request.from_source_id, request.to_source_id]
            : [request.to_source_id, request.from_source_id];
        if (fromId === toId) {
          return c.json(deny('invalid_edge', 'A source cannot syndicate to itself'), 422);
        }
        for (const sourceId of [fromId, toId]) {
          if ((await ingestion.sources.getById(sourceId)) === null) {
            return c.json(deny('unknown_source', `Source ${sourceId} does not exist`), 404);
          }
        }
        const inserted = await ingestion.syndications.insert({
          syndicationId: randomUUID(),
          fromSourceId: fromId,
          toSourceId: toId,
          relationshipType: request.relationship_type,
          establishedBy: 'steward',
          status: 'confirmed', // steward-established edges are confirmed
          evidenceRef: request.evidence_ref,
          confidence: 1,
        });
        if (!inserted.ok) {
          return c.json(deny('duplicate_pair', 'This relationship already exists'), 409);
        }
        await getIdentityServices().audit.append({
          actorUserId: auth.userId,
          eventType: 'syndication_change',
          targetRef: inserted.record.syndicationId,
          context: { setting: 'create', new_value: request.relationship_type },
        });
        return c.json({ syndication: inserted.record }, 201);
      })
      .post(
        '/syndications/:syndicationId/confirm',
        zValidator('param', z.object({ syndicationId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const confirmed = await ingestion.syndications.confirm(
            c.req.valid('param').syndicationId,
          );
          if (!confirmed) return c.json(deny('not_found', 'Relationship not found'), 404);
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'syndication_change',
            targetRef: confirmed.syndicationId,
            context: { setting: 'status', previous_value: 'candidate', new_value: 'confirmed' },
          });
          return c.json({ syndication: confirmed });
        },
      )

      // --- Source-profile editing (WS-F.2.3a) -----------------------------
      .patch(
        '/sources/:sourceId',
        zValidator('param', z.object({ sourceId: uuidSchema })),
        zValidator('json', sourceEditRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const { sourceId } = c.req.valid('param');
          const { reason, ...patch } = c.req.valid('json');
          const before = await ingestion.sources.getById(sourceId);
          if (!before) return c.json(deny('not_found', 'Source not found'), 404);
          const updated = await ingestion.sources.update(sourceId, {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.publisher_lineage !== undefined
              ? { publisherLineage: patch.publisher_lineage }
              : {}),
            ...(patch.typical_topics !== undefined
              ? { typicalTopics: [...patch.typical_topics] }
              : {}),
            ...(patch.display_restrictions !== undefined
              ? { displayRestrictions: patch.display_restrictions }
              : {}),
            ...(patch.community_notes !== undefined
              ? { communityNotes: [...patch.community_notes] }
              : {}),
          });
          // One immutable audit record per edited field, before → after.
          const identity = getIdentityServices();
          for (const field of Object.keys(patch) as Array<keyof typeof patch>) {
            const beforeValue = JSON.stringify(
              field === 'name'
                ? before.name
                : field === 'publisher_lineage'
                  ? before.publisherLineage
                  : field === 'typical_topics'
                    ? before.typicalTopics
                    : field === 'display_restrictions'
                      ? before.displayRestrictions
                      : before.communityNotes,
            ).slice(0, 256);
            await identity.audit.append({
              actorUserId: auth.userId,
              eventType: 'source_profile_edit',
              targetRef: sourceId,
              context: {
                setting: `${field}: ${reason}`.slice(0, 128),
                previous_value: beforeValue,
                new_value: JSON.stringify(patch[field]).slice(0, 256),
              },
            });
          }
          return c.json({ source: updated });
        },
      )
      .post(
        '/sources/:sourceId/corrections',
        zValidator('param', z.object({ sourceId: uuidSchema })),
        zValidator('json', sourceCorrectionAppendSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const request = c.req.valid('json');
          const updated = await ingestion.sources.appendCorrection(c.req.valid('param').sourceId, {
            correction_id: randomUUID(),
            story_id: request.story_id,
            summary: request.summary,
            recorded_by: 'steward',
            recorded_at: new Date(ingestion.now()).toISOString(),
          });
          if (!updated) return c.json(deny('not_found', 'Source not found'), 404);
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'source_profile_edit',
            targetRef: updated.sourceId,
            context: { setting: `correction_append: ${request.reason}`.slice(0, 128) },
          });
          return c.json({ source: updated }, 201);
        },
      )

      // --- Takedown review + actioning (WS-F.1.4f) ------------------------
      .get(
        '/takedowns',
        zValidator(
          'query',
          z.object({
            status: z.enum(['received', 'under_review', 'actioned', 'rejected']).optional(),
          }),
        ),
        async (c) => {
          const ingestion = getIngestionServices();
          const records = await ingestion.takedowns.list(c.req.valid('query').status, 100);
          return c.json({ items: records.map(toTakedownWire) });
        },
      )
      .post(
        '/takedowns/:takedownId/action',
        zValidator('param', z.object({ takedownId: uuidSchema })),
        zValidator('json', takedownActionRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const identity = getIdentityServices();
          const { takedownId } = c.req.valid('param');
          const { action, resolution_note } = c.req.valid('json');
          const record = await ingestion.takedowns.getById(takedownId);
          if (!record) return c.json(deny('not_found', 'Takedown not found'), 404);
          const nowIso = new Date(ingestion.now()).toISOString();
          if (action === 'actioned') {
            // Hide/remove the target (WS-F.1.4f): stories leave every read +
            // search surface; evidence retracts; source restrictions tighten.
            if (record.targetType === 'story') {
              const story = await ingestion.stories.getById(record.targetId);
              if (story) {
                await ingestion.stories.update(story.storyId, { hiddenState: 'takedown' });
                // Best-effort submitter notice (WS-F.1.4f); passkey-only
                // accounts have no email — silently skipped.
                const submitter = await identity.store.getUser(story.submittedBy);
                if (submitter?.email) {
                  try {
                    await identity.mailer.sendNotice(submitter.email, 'takedown_actioned', {
                      story_title: story.title.slice(0, 120),
                    });
                  } catch {
                    ingestion.log('ingestion.takedown_notice_failed', { takedown_id: takedownId });
                  }
                }
              }
            } else {
              await ingestion.sources.update(record.targetId, {
                displayRestrictions: { noindex: true, noarchive: true, excerpt_max_chars: 0 },
              });
              // Cascade (WS-F.1.4f): the publisher's EXISTING stories leave
              // every read + search surface and shed their archived excerpts.
              // Tightening the source's future-extraction flags alone would
              // leave already-extracted content fully visible.
              const hidden = await ingestion.stories.hideBySource(record.targetId, 'takedown');
              ingestion.metrics.increment('takedowns.source_stories_hidden', hidden);
            }
          }
          const updated = await ingestion.takedowns.update(takedownId, {
            status: action,
            resolutionNote: resolution_note,
            actionedBy: auth.userId,
            actionedAt: action === 'actioned' ? nowIso : null,
          });
          await identity.audit.append({
            actorUserId: auth.userId,
            eventType: 'takedown_action',
            targetRef: takedownId,
            context: {
              setting: record.targetType,
              previous_value: record.status,
              new_value: action,
            },
          });
          ingestion.metrics.increment(`takedowns.${action}`);
          return c.json({ takedown: updated === null ? null : toTakedownWire(updated) });
        },
      )

      // --- Steward lifecycle triggers (WS-F.1.1c) -------------------------
      .post(
        '/stories/:storyId/lifecycle',
        zValidator('param', z.object({ storyId: uuidSchema })),
        zValidator('json', z.object({ trigger: z.enum(STORY_LIFECYCLE_TRIGGERS) }).strict()),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const result = await applyLifecycleTrigger(
            ingestion.stories,
            ingestion.lifecycleAudits,
            c.req.valid('param').storyId,
            c.req.valid('json').trigger,
            { actorType: 'steward', actorUserId: auth.userId },
            ingestion.metrics,
          );
          if (!result.applied) {
            return result.reason === 'story_not_found'
              ? c.json(deny('not_found', 'Story not found'), 404)
              : c.json(
                  deny('INVALID_LIFECYCLE_TRANSITION', `Illegal transition from ${result.state}`),
                  422,
                );
          }
          return c.json({ from: result.from, to: result.to });
        },
      )

      // --- Runtime config (fail-closed; WS-E house rule) -------------------
      .get('/config', async (c) => {
        const ingestion = getIngestionServices();
        return c.json({ config: ingestion.config(), keys: INGESTION_CONFIG_KEYS });
      })
      .patch(
        '/config',
        zValidator(
          'json',
          z.object({ key: z.string().min(1).max(64), value: z.unknown() }).strict(),
        ),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { key, value } = c.req.valid('json');
          const problem = validateIngestionConfigValue(key, value);
          if (problem !== null) return c.json(deny('invalid_config', problem), 422);
          const events = getEventPipelineServices();
          const ingestion = getIngestionServices();
          await storeIngestionConfigValue(
            events.configStore,
            key as keyof IngestionRuntimeConfig,
            value,
          );
          await ingestion.reloadConfig();
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'ingestion_config_change',
            context: { setting: key },
          });
          return c.json({ ok: true, key });
        },
      )

      // --- WS-Q.6.2 content rollout flags (fail-closed; audited) -----------
      .get('/content-flags', async (c) => {
        const events = getEventPipelineServices();
        const flags = await loadContentFlags(events.configStore);
        return c.json({ flags, names: CONTENT_FLAG_NAMES });
      })
      .patch(
        '/content-flags',
        zValidator(
          'json',
          z.object({ name: z.string().min(1).max(64), value: z.boolean() }).strict(),
        ),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { name, value } = c.req.valid('json');
          const problem = validateContentFlagValue(name, value);
          if (problem !== null) return c.json(deny('invalid_flag', problem), 422);
          const events = getEventPipelineServices();
          await setContentFlagByName(events.configStore, name, value);
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'ingestion_config_change',
            context: { setting: name },
          });
          return c.json({ ok: true, name });
        },
      )

      // --- Re-embedding / model migration (WS-F.3.2f) ----------------------
      .get('/embeddings/backfill', async (c) => {
        const events = getEventPipelineServices();
        const ingestion = getIngestionServices();
        const progress = await getBackfillProgress(events.configStore);
        return c.json({
          progress,
          active_version: ingestion.config().embeddingActiveVersion,
          provider_version: ingestion.embeddingProvider.modelVersion,
        });
      })
      .post(
        '/embeddings/backfill',
        zValidator('json', z.object({ from_version: z.string().min(1).max(128) }).strict()),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const events = getEventPipelineServices();
          const ingestion = getIngestionServices();
          const progress = await startBackfill(
            events.configStore,
            c.req.valid('json').from_version,
            ingestion.embeddingProvider.modelVersion,
            ingestion.now,
          );
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'ingestion_config_change',
            context: { setting: 'embedding_backfill', new_value: progress.model_version },
          });
          return c.json({ progress }, 202);
        },
      )
      .post(
        '/embeddings/validate',
        zValidator(
          'json',
          z
            .object({
              from_version: z.string().min(1).max(128),
              to_version: z.string().min(1).max(128),
              sample_target_ids: z.array(uuidSchema).min(1).max(100),
            })
            .strict(),
        ),
        async (c) => {
          const ingestion = getIngestionServices();
          const body = c.req.valid('json');
          const validation = await validateBackfill(
            ingestion.embeddings,
            'story',
            body.sample_target_ids,
            body.from_version,
            body.to_version,
            10,
          );
          return c.json({ validation });
        },
      )
      .post(
        '/embeddings/cleanup',
        zValidator('json', z.object({ model_version: z.string().min(1).max(128) }).strict()),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const { model_version } = c.req.valid('json');
          if (model_version === ingestion.config().embeddingActiveVersion) {
            return c.json(deny('active_version', 'Refusing to delete the ACTIVE version'), 422);
          }
          const removed = await ingestion.embeddings.deleteVersion(model_version, 10_000);
          await getIdentityServices().audit.append({
            actorUserId: auth.userId,
            eventType: 'ingestion_config_change',
            context: { setting: 'embedding_cleanup', new_value: model_version },
          });
          return c.json({ removed });
        },
      )

      // --- Observability (counters; no content values) ----------------------
      .get('/metrics', async (c) => {
        const ingestion = getIngestionServices();
        return c.json({ counters: ingestion.metrics.snapshot() });
      })
  );
}

export type IngestionAdminRoutes = ReturnType<typeof createIngestionAdminRoutes>;
