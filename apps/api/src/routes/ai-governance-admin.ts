// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K AI-governance admin surface (SPEC §24.2). Two access tiers:
//   • AI team (requireAiTeam — `ai.model.manage` + MFA): register/version/
//     evaluate/deploy/deprecate models, write runtime config, and read the
//     inventory, blocked-invocation audit, and runtime metrics/alerts.
//   • Stewards (requireSteward): the AI review queue (low-confidence + reported
//     outputs), review resolution, and recording corrections.
// Registration/versioning require a complete card; deploy runs the gate (card +
// passing harness decision + resolved risk assessment); every write is validated.

import { modelCardSchema } from '@licio/ai-governance';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  AI_GOVERNANCE_CONFIG_KEYS,
  storeAiGovernanceConfigValue,
  validateAiGovernanceConfigValue,
} from '../ai-governance/config.js';
import { recordCorrection } from '../ai-governance/correction.js';
import { runEvaluationHarness } from '../ai-governance/harness.js';
import {
  deployModel,
  deprecateModel,
  registerModel,
  versionModel,
} from '../ai-governance/registry.js';
import { getAiGovernanceServices } from '../ai-governance/services.js';
import { buildHarnessDeps, buildRegistryDeps } from '../ai-governance/wiring.js';
import { zValidator } from '../lib/validate.js';
import {
  type AuthEnv,
  authMiddleware,
  getAuth,
  requireAiTeam,
  requireSteward,
} from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

const aiModalitySchema = z.enum(['classification', 'generation', 'embedding']);
const aiRiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
const datasetVersionSchema = z.object({ dataset_id: z.string(), version: z.string() });

/** The evaluation-harness request body (WS-K.1.2e). */
const evaluateBodySchema = z
  .object({
    model_name: z.string().min(1),
    version: z.string().min(1),
    modalities: z.array(aiModalitySchema).min(1),
    risk_level: aiRiskLevelSchema,
    force_red_team: z.boolean().optional(),
    bias: z
      .object({
        metrics: z.array(
          z
            .object({
              dimension: z.enum([
                'language',
                'region',
                'topic_sensitivity',
                'content_length',
                'source_type',
              ]),
              subgroup: z.string(),
              sample_size: z.number().int().nonnegative(),
              accuracy: z.number().min(0).max(1).optional(),
              precision: z.number().min(0).max(1).optional(),
              recall: z.number().min(0).max(1).optional(),
              quality_score: z.number().min(0).max(1).optional(),
            })
            .strict(),
        ),
        accepted_disparities: z.array(z.string()).optional(),
        justification: z.string().nullable().optional(),
        dataset_versions: z.array(datasetVersionSchema).optional(),
      })
      .optional(),
    // Hallucination/grounding evaluation — REQUIRED by the harness for every
    // generation model and every high/critical-risk model, so the admin surface
    // must be able to submit it (else such models can never clear the gate).
    hallucination: z
      .object({
        statements: z.array(
          z
            .object({
              text: z.string(),
              cited_ids: z.array(z.string()),
              cited_source_texts: z.array(z.string()).optional(),
            })
            .strict(),
        ),
        source_text: z.string(),
        valid_citation_ids: z.array(z.string()),
        accepted_with_documentation: z.boolean().optional(),
        dataset_versions: z.array(datasetVersionSchema).optional(),
      })
      .optional(),
    safety: z
      .object({
        cases: z.array(
          z
            .object({
              output_text: z.string(),
              forbidden_private_values: z.array(z.string()).default([]),
              sensitive_topic: z.boolean().default(false),
              forbidden_cross_invocation_values: z.array(z.string()).default([]),
            })
            .strict(),
        ),
        harmful_term_denylist: z.array(z.string()),
        disclaimer_markers: z.array(z.string()),
      })
      .optional(),
    red_team: z
      .object({
        inputs: z.array(
          z
            .object({
              category: z.enum(['adversarial_prompts', 'jailbreaks', 'bias_probing', 'edge_cases']),
              test_count: z.number().int().nonnegative(),
              critical_findings: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        accepted_risks: z.array(z.string()).optional(),
        dataset_versions: z.array(datasetVersionSchema).optional(),
      })
      .optional(),
  })
  .strict();

const correctionBodySchema = z
  .object({
    output_id: z.string().min(1),
    use_case_id: z.string().min(1),
    action: z.enum(['confirm', 'reject', 'modify']),
    original_value: z.string().min(1),
    corrected_value: z.string().nullable(),
    category: z.string().nullable(),
  })
  .strict();

const configBodySchema = z.object({ key: z.string().min(1), value: z.unknown() }).strict();
// The deprecate + review-resolve writes were parsing raw JSON; validate them at
// the trust boundary too (the file's "every write is validated" contract). Both
// tolerate an absent body (the fields default), so parse leniently then refine.
const deprecateBodySchema = z
  .object({
    reason: z.string().max(1000).optional(),
    recommended_replacement: z.string().max(200).optional(),
  })
  .strict();
const reviewResolveBodySchema = z.object({ resolution: z.string().max(1000).optional() }).strict();

export function createAiGovernanceAdminRoutes() {
  return (
    new Hono<AuthEnv>()
      .use('*', authMiddleware())

      // --- AI-team model lifecycle (WS-K.1.1b) ---
      .post('/models', requireAiTeam(), zValidator('json', modelCardSchema), async (c) => {
        const ai = getAiGovernanceServices();
        const result = await registerModel(buildRegistryDeps(ai), c.req.valid('json'));
        if (!result.ok) return c.json(deny(result.code, result.message), 422);
        return c.json({ model: result.model }, 201);
      })
      .post('/models/version', requireAiTeam(), zValidator('json', modelCardSchema), async (c) => {
        const ai = getAiGovernanceServices();
        const result = await versionModel(buildRegistryDeps(ai), c.req.valid('json'));
        if (!result.ok) return c.json(deny(result.code, result.message), 422);
        return c.json({ model: result.model }, 201);
      })
      .post(
        '/models/evaluate',
        requireAiTeam(),
        zValidator('json', evaluateBodySchema),
        async (c) => {
          const ai = getAiGovernanceServices();
          const body = c.req.valid('json');
          const decision = await runEvaluationHarness(buildHarnessDeps(ai), {
            modelName: body.model_name,
            version: body.version,
            modalities: body.modalities,
            riskLevel: body.risk_level,
            ...(body.force_red_team !== undefined ? { forceRedTeam: body.force_red_team } : {}),
            ...(body.bias
              ? {
                  bias: {
                    metrics: body.bias.metrics,
                    ...(body.bias.accepted_disparities
                      ? { acceptedDisparities: new Set(body.bias.accepted_disparities) }
                      : {}),
                    ...(body.bias.justification !== undefined
                      ? { justification: body.bias.justification }
                      : {}),
                    ...(body.bias.dataset_versions
                      ? { datasetVersions: body.bias.dataset_versions }
                      : {}),
                  },
                }
              : {}),
            ...(body.hallucination
              ? {
                  hallucination: {
                    input: {
                      statements: body.hallucination.statements.map((s) => ({
                        text: s.text,
                        cited_ids: s.cited_ids,
                        ...(s.cited_source_texts
                          ? { cited_source_texts: s.cited_source_texts }
                          : {}),
                      })),
                      source_text: body.hallucination.source_text,
                      valid_citation_ids: new Set(body.hallucination.valid_citation_ids),
                    },
                    ...(body.hallucination.accepted_with_documentation !== undefined
                      ? {
                          acceptedWithDocumentation: body.hallucination.accepted_with_documentation,
                        }
                      : {}),
                    ...(body.hallucination.dataset_versions
                      ? { datasetVersions: body.hallucination.dataset_versions }
                      : {}),
                  },
                }
              : {}),
            ...(body.safety ? { safety: body.safety } : {}),
            ...(body.red_team
              ? {
                  redTeam: {
                    inputs: body.red_team.inputs,
                    ...(body.red_team.accepted_risks
                      ? { acceptedRisks: body.red_team.accepted_risks }
                      : {}),
                    ...(body.red_team.dataset_versions
                      ? { datasetVersions: body.red_team.dataset_versions }
                      : {}),
                  },
                }
              : {}),
          });
          return c.json({ decision });
        },
      )
      .post('/models/:name/:version/deploy', requireAiTeam(), async (c) => {
        const ai = getAiGovernanceServices();
        const result = await deployModel(
          buildRegistryDeps(ai),
          c.req.param('name'),
          c.req.param('version'),
        );
        if (!result.ok) return c.json(deny(result.code, result.message), 422);
        return c.json({ model: result.model });
      })
      .post('/models/:name/:version/deprecate', requireAiTeam(), async (c) => {
        const ai = getAiGovernanceServices();
        const parsed = deprecateBodySchema.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) return c.json(deny('invalid_body', 'Malformed request body'), 422);
        const reason = parsed.data.reason ?? 'deprecated';
        const replacement = parsed.data.recommended_replacement ?? null;
        const result = await deprecateModel(
          buildRegistryDeps(ai),
          c.req.param('name'),
          c.req.param('version'),
          reason,
          replacement,
        );
        if (!result.ok) return c.json(deny('not_found', result.message), 404);
        return c.json({ model: result.model });
      })

      // --- AI-team read surfaces (WS-K.1.1c/d, 1.2f) ---
      .get('/inventory', requireAiTeam(), async (c) => {
        const ai = getAiGovernanceServices();
        const inventory = await ai.inventory.latest();
        return c.json({ inventory });
      })
      .get('/blocked', requireAiTeam(), async (c) => {
        const ai = getAiGovernanceServices();
        const records = await ai.blocked.list(100);
        const byProhibition = await ai.blocked.countByProhibition();
        return c.json({ records, by_prohibition: byProhibition });
      })
      .get('/runtime/alerts', requireAiTeam(), async (c) => {
        const ai = getAiGovernanceServices();
        return c.json({ alerts: await ai.runtime.listAlerts(100) });
      })
      // WS-U ADR-9 observability: the boot-resolved governed-LLM status — which
      // backend/model each role lane runs (moderation / adjudication), whether
      // the DEV simulated runtime stands in per lane, and which governed
      // surfaces are ACTIVE with their fail-closed deterministic fallbacks.
      // The first-class "is the AI actually running?" answer (config only —
      // never a key; per-call health lives in the breaker metrics).
      .get('/governance/llm', requireAiTeam(), async (c) => {
        const ai = getAiGovernanceServices();
        return c.json({ status: ai.llmStatus ?? null });
      })
      // WS-U ADR-9: the in-room moderation decision log for a room — for each
      // decision, what the LLM model PROPOSED vs what the deterministic wrapper
      // (escalate-to-review ceiling + capability clamp) actually PERMITTED, plus
      // how often the wrapper reduced the model. The transparency of bounded
      // autonomy — an operator sees the model's behaviour and its bounds.
      .get('/governance/moderation/:roomId', requireAiTeam(), async (c) => {
        const ai = getAiGovernanceServices();
        const roomId = c.req.param('roomId');
        const requested = Number.parseInt(c.req.query('limit') ?? '100', 10);
        const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
        const [summary, records] = await Promise.all([
          ai.moderationLog.summaryByRoom(roomId),
          ai.moderationLog.listByRoom(roomId, limit),
        ]);
        return c.json({ summary, records });
      })
      .put('/config', requireAiTeam(), zValidator('json', configBodySchema), async (c) => {
        const ai = getAiGovernanceServices();
        const { key, value } = c.req.valid('json');
        if (!(AI_GOVERNANCE_CONFIG_KEYS as readonly string[]).includes(key)) {
          return c.json(deny('unknown_key', `unknown ai config key '${key}'`), 422);
        }
        const problem = validateAiGovernanceConfigValue(key, value);
        if (problem !== null) return c.json(deny('invalid_value', problem), 422);
        await storeAiGovernanceConfigValue(ai.events.configStore, key, value);
        await ai.reloadConfig();
        return c.json({ ok: true });
      })

      // --- Steward review surfaces (WS-K.1.3c) ---
      .get('/review', requireSteward(), async (c) => {
        const ai = getAiGovernanceServices();
        const items = await ai.reviewQueue.list({ status: 'pending' }, 100);
        // EVERY report for the subject, not just the one that opened the item.
        // A repeat report about a pending subject is deliberately deduped at the
        // queue (`ai_review_queue_pending_subject_uq`) so a steward triages one
        // entry — but the incumbent's `context` is a frozen snapshot of the
        // FIRST report, so every later reason and correction text was persisted
        // and then unreachable: the report stores had no production reader at
        // all.  Reading them here keeps the dedup (one item) while giving the
        // steward what they are triaging (all of it), and leaves the incumbent's
        // own evidence unrewritten.
        const enriched = await Promise.all(
          items.map(async (item) => {
            const reports =
              item.kind === 'reported_summary'
                ? await ai.summaries.listReports(item.subjectRef)
                : item.kind === 'reported_translation'
                  ? await ai.translations.listReports(item.subjectRef)
                  : [];
            return { ...item, report_count: reports.length, reports };
          }),
        );
        return c.json({ items: enriched });
      })
      .post('/review/:id/resolve', requireSteward(), async (c) => {
        const ai = getAiGovernanceServices();
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const parsed = reviewResolveBodySchema.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) return c.json(deny('invalid_body', 'Malformed request body'), 422);
        const resolution = parsed.data.resolution ?? 'reviewed';
        const item = await ai.reviewQueue.resolve(
          c.req.param('id'),
          resolution,
          `steward:${auth.userId}`,
          new Date(ai.now()).toISOString(),
        );
        if (item === null) return c.json(deny('not_found', 'review item not found'), 404);
        return c.json({ item });
      })
      .post(
        '/corrections',
        requireSteward(),
        zValidator('json', correctionBodySchema),
        async (c) => {
          const ai = getAiGovernanceServices();
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const body = c.req.valid('json');
          const useCaseParsed = z
            .enum([
              'topic_classification',
              'duplicate_detection',
              'claim_extraction',
              'toxicity_safety_triage',
              'summarization',
              'translation',
              'embedding_generation',
              'governance_assistance',
            ])
            .safeParse(body.use_case_id);
          if (!useCaseParsed.success) return c.json(deny('invalid', 'unknown use_case_id'), 422);
          const result = await recordCorrection(
            {
              corrections: ai.corrections,
              outputRecords: ai.outputRecords,
              metrics: ai.metrics,
              log: ai.log,
              now: ai.now,
            },
            {
              outputId: body.output_id,
              useCaseId: useCaseParsed.data,
              action: body.action,
              originalValue: body.original_value,
              correctedValue: body.corrected_value,
              stewardRef: `steward:${auth.userId}`,
              category: body.category,
            },
          );
          if (!result.ok) return c.json(deny(result.reason, 'correction failed'), 422);
          return c.json({ correction: result.correction }, 201);
        },
      )
  );
}
