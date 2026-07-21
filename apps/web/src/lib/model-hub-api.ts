// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U model-hub client flows (SPEC §24.6): the propose form's model picker search
// + revision-pinning resolve, typed against the BFF `/v1/model-hub` surface —
// the browser NEVER talks to huggingface.co directly (connect-src stays
// 'self'; the BFF proxies metadata only). Every response is zod-validated
// before it can reach the TanStack Query cache.
import {
  hubRepoIdSchema,
  type ModelHubResolveResponse,
  type ModelHubSearchResponse,
  modelHubResolveResponseSchema,
  modelHubSearchResponseSchema,
} from '@licio/shared';
import { client, parseResponse } from './api.js';

export async function searchModelHub(query: string): Promise<ModelHubSearchResponse> {
  const res = await client.v1['model-hub'].search.$get({ query: { q: query } });
  return parseResponse(res, modelHubSearchResponseSchema);
}

/** Resolve a repo to its CURRENT head revision — the sha the picker PINS into
 *  the bundle (immutable on the hub; what members then ratify byte-exactly). */
export async function resolveModelHubModel(repoId: string): Promise<ModelHubResolveResponse> {
  // Validate BEFORE splitting: `split('/', 2)` silently truncates a
  // multi-slash string to the wrong repo, and the schema guarantees exactly
  // one separator (the server re-validates regardless — defence in depth).
  const [owner, repo] = hubRepoIdSchema.parse(repoId).split('/');
  const res = await client.v1['model-hub'].models[':owner'][':repo'].$get({
    param: { owner: owner ?? '', repo: repo ?? '' },
    query: {},
  });
  return parseResponse(res, modelHubResolveResponseSchema);
}
