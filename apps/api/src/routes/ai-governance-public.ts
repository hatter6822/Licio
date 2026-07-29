// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K AI-governance public surface (SPEC §24.2). Open to any authenticated user:
//   • model-card LOOKUP (transparency — every model's card is queryable);
//   • request a translation (WS-K.2.1a — original stays canonical);
//   • report a bad summary or translation (WS-K.1.4c / WS-K.2.1a — routes to the
//     steward review queue + the model-improvement loop; reporter identity is
//     never exposed).

import {
  SUMMARY_REPORT_REASONS,
  TRANSLATION_REPORT_REASONS,
  TRANSLATION_SOURCE_KINDS,
} from '@licio/ai-governance';
import { Hono } from 'hono';
import { z } from 'zod';
import { lookupModels } from '../ai-governance/registry.js';
import { getAiGovernanceServices } from '../ai-governance/services.js';
import { reportSummary } from '../ai-governance/summaries.js';
import { reportTranslation, translateContent } from '../ai-governance/translation.js';
import {
  buildRegistryDeps,
  buildSummaryDeps,
  buildTranslationDeps,
} from '../ai-governance/wiring.js';
import { perAccountRateLimit, rateLimit } from '../lib/rate-limit.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, getAuth } from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

const translateBodySchema = z
  .object({
    source_kind: z.enum(TRANSLATION_SOURCE_KINDS),
    source_ref: z.string().min(1).max(256),
    source_text: z.string().min(1).max(20_000),
    source_lang: z.string().min(2).max(16),
    target_lang: z.string().min(2).max(16),
  })
  .strict();

const summaryReportBodySchema = z
  .object({
    reason: z.enum(SUMMARY_REPORT_REASONS),
    correction_text: z.string().max(8_000).nullable().optional(),
  })
  .strict();

const translationReportBodySchema = z
  .object({ reason: z.enum(TRANSLATION_REPORT_REASONS) })
  .strict();

/**
 * WS-K report-route budget (SPEC §19.1: never per-IP).
 *
 * TWO limiters, because they answer different questions and only one of them is
 * an abuse budget.
 *
 * The per-ACCOUNT window is the abuse control.  A single global window is a
 * load-shedding ceiling that counts every caller into one bucket, so one
 * authenticated account could spend the whole allowance — with invalid bodies
 * too, since a limiter runs before validation — and every other user would
 * receive 429 from BOTH report routes for the rest of the minute.  That lets one
 * reporter disable reporting platform-wide, which is a worse failure than the
 * unbounded writes the limit was added for.
 *
 * The global window stays underneath as a much higher process ceiling, so a
 * broad distributed flood still cannot make these routes the most expensive
 * thing the process does.  Both are shared by the two routes, so a caller cannot
 * spend the summary budget and then the translation one.
 */
const reportAccountLimit = perAccountRateLimit({
  limit: 20,
  windowMs: 60_000,
  // The routes run `authMiddleware()` first, so an authenticated caller always
  // has an id here; an unauthenticated one is refused before this ever runs.
  accountId: (c) => getAuth(c as unknown as Parameters<typeof getAuth>[0])?.userId ?? null,
});
const reportGlobalLimit = rateLimit({ limit: 600, windowMs: 60_000 });

export function createAiGovernancePublicRoutes() {
  // Mounted at '/', so auth is applied PER-ROUTE (a `.use('*')` here would leak
  // the wildcard to the whole '/v1' scope and gate unrelated public routes).
  return (
    new Hono<AuthEnv>()

      // Model-card transparency: lookup is open to all authenticated users.
      .get('/ai/models', authMiddleware(), async (c) => {
        const ai = getAiGovernanceServices();
        const name = c.req.query('name');
        const status = c.req.query('status');
        const filter: Parameters<typeof lookupModels>[1] = {
          ...(name ? { name } : {}),
          ...(status === 'registered' || status === 'deployed' || status === 'deprecated'
            ? { status }
            : {}),
        };
        const models = await lookupModels(buildRegistryDeps(ai), filter);
        // Cards only (no internal lifecycle leakage beyond status/version).
        return c.json({
          models: models.map((m) => ({
            name: m.name,
            version: m.version,
            status: m.status,
            card: m.card,
            deprecation: m.deprecation,
          })),
        });
      })
      .get('/ai/models/:name/:version', authMiddleware(), async (c) => {
        const ai = getAiGovernanceServices();
        const model = await ai.registry.getVersion(c.req.param('name'), c.req.param('version'));
        if (model === null) return c.json(deny('not_found', 'model not found'), 404);
        return c.json({ model });
      })

      // Translation (WS-K.2.1a) — the original (source_ref) stays canonical.
      .post(
        '/ai/translations',
        authMiddleware(),
        zValidator('json', translateBodySchema),
        async (c) => {
          const ai = getAiGovernanceServices();
          const body = c.req.valid('json');
          const translation = await translateContent(buildTranslationDeps(ai), {
            sourceKind: body.source_kind,
            sourceRef: body.source_ref,
            sourceText: body.source_text,
            sourceLang: body.source_lang,
            targetLang: body.target_lang,
          });
          return c.json({ translation }, 201);
        },
      )
      .post(
        '/ai/translations/:id/report',
        authMiddleware(),
        reportGlobalLimit,
        reportAccountLimit,
        zValidator('json', translationReportBodySchema),
        async (c) => {
          const ai = getAiGovernanceServices();
          const report = await reportTranslation(
            buildTranslationDeps(ai),
            c.req.param('id'),
            c.req.valid('json').reason,
          );
          if (report === null) return c.json(deny('not_found', 'Translation not found.'), 404);
          return c.json({ report }, 201);
        },
      )

      // Summary reports (WS-K.1.4c) — reporter identity is never stored/exposed.
      .post(
        '/ai/summaries/:id/report',
        authMiddleware(),
        reportGlobalLimit,
        reportAccountLimit,
        zValidator('json', summaryReportBodySchema),
        async (c) => {
          const ai = getAiGovernanceServices();
          const body = c.req.valid('json');
          const report = await reportSummary(
            buildSummaryDeps(ai),
            c.req.param('id'),
            body.reason,
            body.correction_text ?? null,
          );
          if (report === null) return c.json(deny('not_found', 'Summary not found.'), 404);
          return c.json({ report }, 201);
        },
      )
  );
}
