// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The HuggingFace MODEL-HUB client (WS-U model candidacy): server-side,
// METADATA-ONLY reads against the fixed https://huggingface.co host — member
// model search and revision-pinned candidate verification. No room content, no
// user identifier, and no model weights ever move through here (weights are
// pulled by the operator's runtime, never by the BFF). The client is the BFF's
// only hub egress and is fail-closed at every edge: a typed error per failure
// class, `redirect: 'error'` (a redirect is never followed off the fixed
// host), tight timeouts, zod at the trust boundary, and a bounded TTL cache so
// member-driven search cannot hammer the hub. GOVERNANCE_MODEL_HUB=off
// removes the client at boot — the /v1/model-hub surface then answers 503 and
// hub-referencing bundles are rejected at propose time.

import type { HubModelMetadata, HubModelRef, ModelHubSearchResult } from '@licio/shared';
import {
  type HUB_CANDIDATE_PIPELINES,
  hubModelMetadataSchema,
  hubPipelineTagSchema,
  hubRepoIdSchema,
  hubRevisionSchema,
  modelHubSearchResultSchema,
} from '@licio/shared';
import { z } from 'zod';

export type ModelHubErrorCode =
  | 'not_found'
  | 'gated'
  | 'unsupported_pipeline'
  | 'revision_mismatch'
  | 'transport'
  | 'invalid_response';

/** Typed hub failure the propose route maps onto its error vocabulary. */
export class ModelHubError extends Error {
  readonly code: ModelHubErrorCode;
  constructor(code: ModelHubErrorCode, message: string) {
    super(message);
    this.name = 'ModelHubError';
    this.code = code;
  }
}

export interface ModelHubClient {
  /** Member model search (public, text-capable models; gated rows flagged). */
  search(query: string, limit?: number): Promise<ModelHubSearchResult[]>;
  /** Resolve a repo to its CURRENT head revision (the sha the picker pins).
   *  Throws a ModelHubError on every failure class. */
  resolve(repoId: string): Promise<HubModelMetadata>;
  /** Verify a revision-pinned candidate reference against the hub. Throws a
   *  ModelHubError on every failure class; returns the verified snapshot. */
  verify(ref: HubModelRef): Promise<HubModelMetadata>;
}

/** The narrow GET-fetch surface (tests inject a fake; global fetch satisfies
 *  it structurally). `redirect: 'error'` — the fixed-host guarantee. */
export type HubFetchLike = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const HUB_BASE_URL = 'https://huggingface.co';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 300_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_SEARCH_LIMIT = 25;

/** The hub list/detail response surfaces consumed here (unknown keys stripped;
 *  `gated` is false | 'auto' | 'manual' on the wire — any non-false is gated). */
const hubModelItemSchema = z.object({
  id: z.string().min(1),
  sha: z.string().optional(),
  pipeline_tag: z.string().optional(),
  gated: z.union([z.boolean(), z.string()]).optional(),
  private: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  safetensors: z.object({ total: z.number().int().positive() }).optional(),
});
const hubSearchListSchema = z.array(hubModelItemSchema);

function isGated(value: boolean | string | undefined): boolean {
  return value !== undefined && value !== false;
}

function licenseFromTags(tags: readonly string[] | undefined): string | null {
  for (const tag of tags ?? []) {
    if (tag.startsWith('license:')) {
      const slug = tag.slice('license:'.length).trim();
      if (slug.length > 0) return slug.slice(0, 64);
    }
  }
  return null;
}

function candidatePipeline(
  value: string | undefined,
): (typeof HUB_CANDIDATE_PIPELINES)[number] | null {
  const parsed = hubPipelineTagSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface HttpModelHubClientOptions {
  fetchImpl?: HubFetchLike;
  /** Optional hub API token (rate-limit headroom only; gated models stay
   *  rejected as candidates regardless — the token never widens candidacy). */
  token?: string | undefined;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
}

/** The production hub client (plain fetch; no SDK, no new dependency). */
export class HttpModelHubClient implements ModelHubClient {
  readonly #fetch: HubFetchLike;
  readonly #token: string | undefined;
  readonly #now: () => number;
  readonly #cacheTtlMs: number;
  readonly #timeoutMs: number;
  readonly #cache = new Map<string, { atMs: number; value: unknown }>();

  constructor(options: HttpModelHubClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#token = options.token;
    this.#now = options.now ?? Date.now;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #getJson(url: string): Promise<unknown> {
    const cached = this.#cache.get(url);
    if (cached && this.#now() - cached.atMs < this.#cacheTtlMs) return cached.value;
    let response: Awaited<ReturnType<HubFetchLike>>;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(this.#token !== undefined ? { authorization: `Bearer ${this.#token}` } : {}),
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new ModelHubError(
        'transport',
        `model hub unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    // The hub answers 401 for a repo that does not exist (or is private) on an
    // unauthenticated read — both are "not a selectable candidate".
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new ModelHubError('not_found', `model hub responded ${response.status}`);
    }
    if (!response.ok) {
      throw new ModelHubError('transport', `model hub responded ${response.status}`);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ModelHubError('invalid_response', 'model hub returned non-JSON');
    }
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(url, { atMs: this.#now(), value });
    return value;
  }

  async search(query: string, limit = 10): Promise<ModelHubSearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    const capped = Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT);
    const url = `${HUB_BASE_URL}/api/models?search=${encodeURIComponent(trimmed)}&limit=${capped}&sort=downloads&direction=-1`;
    const raw = await this.#getJson(url);
    const parsed = hubSearchListSchema.safeParse(raw);
    if (!parsed.success) throw new ModelHubError('invalid_response', 'unexpected hub list shape');
    const results: ModelHubSearchResult[] = [];
    for (const item of parsed.data) {
      if (item.private === true) continue;
      const pipeline = candidatePipeline(item.pipeline_tag);
      if (pipeline === null) continue;
      if (!hubRepoIdSchema.safeParse(item.id).success) continue;
      results.push(
        modelHubSearchResultSchema.parse({
          repo_id: item.id,
          pipeline_tag: pipeline,
          license: licenseFromTags(item.tags),
          gated: isGated(item.gated),
        }),
      );
    }
    return results;
  }

  /** Fetch + shape-check one hub model item, enforcing the candidacy rules
   *  shared by `resolve` and `verify` (public, text-capable pipeline). */
  async #candidateItem(url: string): Promise<z.infer<typeof hubModelItemSchema>> {
    const raw = await this.#getJson(url);
    const parsed = hubModelItemSchema.safeParse(raw);
    if (!parsed.success) throw new ModelHubError('invalid_response', 'unexpected hub model shape');
    const item = parsed.data;
    if (isGated(item.gated) || item.private === true) {
      throw new ModelHubError('gated', 'gated/private models are not selectable candidates');
    }
    if (candidatePipeline(item.pipeline_tag) === null) {
      throw new ModelHubError(
        'unsupported_pipeline',
        `pipeline "${item.pipeline_tag ?? 'unknown'}" is not a text-capable candidate pipeline`,
      );
    }
    return item;
  }

  #metadata(
    repoId: string,
    revision: string,
    item: z.infer<typeof hubModelItemSchema>,
  ): HubModelMetadata {
    return hubModelMetadataSchema.parse({
      repo_id: repoId,
      revision,
      pipeline_tag: candidatePipeline(item.pipeline_tag),
      license: licenseFromTags(item.tags),
      parameter_count: item.safetensors?.total ?? null,
      fetched_at: new Date(this.#now()).toISOString(),
    });
  }

  async resolve(repoId: string): Promise<HubModelMetadata> {
    const id = hubRepoIdSchema.parse(repoId);
    const item = await this.#candidateItem(`${HUB_BASE_URL}/api/models/${id}`);
    // The head sha is what the picker PINS — a repo the hub cannot give a
    // resolvable commit for is not a pinnable candidate.
    if (item.sha === undefined || !/^[0-9a-f]{40}$/.test(item.sha)) {
      throw new ModelHubError('invalid_response', 'hub did not expose a resolvable head revision');
    }
    return this.#metadata(id, item.sha, item);
  }

  async verify(ref: HubModelRef): Promise<HubModelMetadata> {
    // Defence-in-depth: the ref is schema-validated upstream, but this client
    // builds a URL path from BOTH parts — re-validate each before interpolation.
    const repoId = hubRepoIdSchema.parse(ref.repoId);
    const revision = hubRevisionSchema.parse(ref.revision);
    const item = await this.#candidateItem(
      `${HUB_BASE_URL}/api/models/${repoId}/revision/${revision}`,
    );
    // The revision endpoint must ECHO the resolved commit. A response without
    // a well-formed sha carries no evidence that the served snapshot is the
    // requested immutable commit, so it is refused outright (fail-closed,
    // symmetric with `resolve`) — acceptance requires the echo to equal the pin.
    if (item.sha === undefined || !/^[0-9a-f]{40}$/.test(item.sha)) {
      throw new ModelHubError(
        'invalid_response',
        'hub did not echo a resolvable commit for the pin',
      );
    }
    if (item.sha !== ref.revision) {
      throw new ModelHubError('revision_mismatch', 'hub resolved a different commit for the pin');
    }
    return this.#metadata(repoId, ref.revision, item);
  }
}
