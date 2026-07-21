// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U /v1/model-hub — the member model-candidacy READ surface (SPEC §24.6):
// search public huggingface.co models and resolve a repo to a pinnable
// revision snapshot, both proxied through the BFF's metadata-only hub client
// (the browser never talks to a third party — connect-src stays 'self').
// Read-only GETs behind the session (no KYC gate: candidacy WRITES — the
// bundle propose — carry it), a global fixed-window budget (identity-free,
// §19.1) in front, and 503 when the hub is disabled (GOVERNANCE_MODEL_HUB=off)
// — fail-closed, matching the propose-time `hub_disabled` rejection.

import { zValidator } from '@hono/zod-validator';
import {
  hubRevisionSchema,
  modelHubResolveResponseSchema,
  modelHubSearchResponseSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { ModelHubError } from '../ai-governance/model-hub.js';
import { getAiGovernanceServices } from '../ai-governance/services.js';
import { rateLimit } from '../lib/rate-limit.js';
import { type AuthEnv, authMiddleware } from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

const searchQuerySchema = z
  .object({
    q: z.string().min(2).max(120),
    limit: z.coerce.number().int().min(1).max(25).optional(),
  })
  .strict();

const resolveQuerySchema = z.object({ revision: hubRevisionSchema.optional() }).strict();

/** Map a hub-client failure onto the wire (definitive refusals are 422s the
 *  picker can explain; a transport fault is an honest 502). */
function hubErrorResponse(error: unknown): { status: 422 | 502; code: string; message: string } {
  if (error instanceof ModelHubError) {
    if (error.code === 'transport') {
      return {
        status: 502,
        code: 'hub_unavailable',
        message: 'The model hub could not be reached.',
      };
    }
    return { status: 422, code: `hub_model_${error.code}`, message: error.message };
  }
  return { status: 502, code: 'hub_unavailable', message: 'The model hub could not be reached.' };
}

export function createModelHubRoutes() {
  // Identity-free per-endpoint load shedding (§19.1): candidacy search is a
  // low-rate tooling surface; the budget bounds what one process spends on
  // hub egress per window regardless of who asks.
  const budget = rateLimit({ limit: 120, windowMs: 60_000 });

  return new Hono<AuthEnv>()
    .get('/search', budget, authMiddleware(), zValidator('query', searchQuerySchema), async (c) => {
      const hub = getAiGovernanceServices().modelHub;
      if (!hub) return c.json(deny('hub_disabled', 'The model hub is disabled.'), 503);
      const { q, limit } = c.req.valid('query');
      try {
        const results = await hub.search(q, limit ?? 10);
        return c.json(modelHubSearchResponseSchema.parse({ results }));
      } catch (error) {
        const mapped = hubErrorResponse(error);
        return c.json(deny(mapped.code, mapped.message), mapped.status);
      }
    })
    .get(
      '/models/:owner/:repo',
      budget,
      authMiddleware(),
      zValidator('query', resolveQuerySchema),
      async (c) => {
        const hub = getAiGovernanceServices().modelHub;
        if (!hub) return c.json(deny('hub_disabled', 'The model hub is disabled.'), 503);
        const repoId = `${c.req.param('owner')}/${c.req.param('repo')}`;
        const { revision } = c.req.valid('query');
        try {
          const metadata =
            revision === undefined
              ? await hub.resolve(repoId)
              : await hub.verify({ source: 'huggingface', repoId, revision });
          return c.json(modelHubResolveResponseSchema.parse({ metadata }));
        } catch (error) {
          if (error instanceof z.ZodError) {
            return c.json(deny('invalid_repo', 'Not a valid hub repo id.'), 422);
          }
          const mapped = hubErrorResponse(error);
          return c.json(deny(mapped.code, mapped.message), mapped.status);
        }
      },
    );
}
