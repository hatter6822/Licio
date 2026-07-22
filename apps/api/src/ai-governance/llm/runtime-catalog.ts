// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The LOCAL-RUNTIME MODEL CATALOG (WS-U model candidacy): which loopback
// OpenAI-compatible runtime serves which model, discovered via the standard
// `GET /v1/models` listing every supported runtime exposes (vLLM lists its one
// served model; Ollama lists every pulled model). The room-model resolver uses
// it to locate a ratified hub model among the configured runtimes (the two
// lane URLs + GOVERNANCE_LLM_EXTRA_RUNTIME_URLS — all loopback-enforced
// upstream). Probes are TTL-cached (a failed probe caches briefly, so a down
// runtime is re-checked soon without hammering it); an unlocatable model is
// simply `null` — the callers fail closed (admission stays retryable, live
// surfaces degrade to their deterministic paths).
//
// DEV wildcard: the DEV-ONLY simulated runtime serves every governed surface
// under its single model id. When a probed runtime reports that id, any model
// not otherwise located resolves to the simulator (under the sim's own served
// id, so nothing pretends the real weights ran) — the full hub-candidacy flow
// is exercisable in `pnpm dev` with zero setup. The sim id is never served by
// a real runtime and the simulator refuses to start in production, so this
// branch is structurally dev-only.

import { z } from 'zod';
import { SIMULATED_GOVERNANCE_LLM_MODEL_ID } from './config.js';
import { stripTrailingSlashes } from './local.js';

/** The minimal /v1/models response surface (zod at the trust boundary). */
const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

/** The narrow GET-fetch surface (tests inject a fake; global fetch satisfies
 *  it structurally — Node 22, no dependency). */
export type CatalogFetchLike = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    /** Loopback guarantee: a redirect must FAIL, never be followed off-host. */
    redirect: 'error';
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RuntimeCatalogLocation {
  baseUrl: string;
  /** The id the runtime actually serves the model under (the sim wildcard
   *  resolves to the sim's own id — provenance never pretends otherwise). */
  servedModelId: string;
}

export interface RuntimeCatalog {
  /** Locate the runtime serving `servedModelId`, or null when none does. */
  locate(servedModelId: string): Promise<RuntimeCatalogLocation | null>;
}

export interface RuntimeCatalogOptions {
  /** Loopback base URLs to probe, in precedence order (lane URLs first). */
  urls: readonly string[];
  fetchImpl?: CatalogFetchLike;
  now?: () => number;
  /** How long a successful probe stays fresh (default 30 s). */
  ttlMs?: number;
  /** How long a FAILED probe is remembered before re-probing (default 5 s). */
  failureTtlMs?: number;
  /** Per-probe transport timeout (default 3 s — the catalog sits in front of
   *  admission and live-path resolution, so a hung runtime must not stall it). */
  probeTimeoutMs?: number;
  log?: (event: string, meta: Record<string, unknown>) => void;
}

function modelsUrl(baseUrl: string): string {
  return `${stripTrailingSlashes(baseUrl)}/models`;
}

/** One boot-time lane-liveness verdict (the dev vLLM-preference probe). */
export type LaneRuntimeProbe =
  /** The runtime answers /models AND lists the lane's model — completions
   *  against this (URL, model) pair can succeed. */
  | 'live'
  /** The runtime answers /models but does NOT list the lane's model (e.g. an
   *  Ollama that has not pulled it, or a vLLM serving something else) — every
   *  completion would 404, so the lane is not usable as configured. */
  | 'no_model'
  /** Nothing (parseable) is listening at the URL. */
  | 'down';

/**
 * Probe whether a loopback runtime is LIVE for a lane — listening at `baseUrl`
 * and actually serving `modelId` (the standard `GET /v1/models` listing every
 * supported runtime exposes). Used by the DEV boot to prefer real lanes over
 * the simulated runtime, and honest about the middle state: a listening
 * runtime without the model is `no_model`, not `live` — a lane pointed at it
 * would fail every completion. One-shot (no cache): boot probes once.
 */
export async function probeLaneRuntime(
  baseUrl: string,
  modelId: string,
  options: { fetchImpl?: CatalogFetchLike; timeoutMs?: number } = {},
): Promise<LaneRuntimeProbe> {
  const fetchImpl: CatalogFetchLike = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1_500;
  try {
    const response = await fetchImpl(modelsUrl(baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) return 'down';
    const parsed = modelListSchema.parse(await response.json());
    return parsed.data.some((entry) => entry.id === modelId) ? 'live' : 'no_model';
  } catch {
    return 'down';
  }
}

export function createRuntimeCatalog(options: RuntimeCatalogOptions): RuntimeCatalog {
  const fetchImpl: CatalogFetchLike = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const failureTtlMs = options.failureTtlMs ?? 5_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
  const log = options.log ?? (() => {});
  // De-duplicate while preserving the configured precedence order.
  const urls = [...new Set(options.urls)];

  /** null models ⇒ the last probe FAILED (cached briefly). */
  const cache = new Map<string, { atMs: number; models: Set<string> | null }>();

  const probe = async (baseUrl: string): Promise<Set<string> | null> => {
    const cached = cache.get(baseUrl);
    if (cached) {
      const age = now() - cached.atMs;
      if (cached.models !== null ? age < ttlMs : age < failureTtlMs) return cached.models;
    }
    try {
      const response = await fetchImpl(modelsUrl(baseUrl), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(probeTimeoutMs),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`runtime responded ${response.status}`);
      const parsed = modelListSchema.parse(await response.json());
      const models = new Set(parsed.data.map((entry) => entry.id));
      cache.set(baseUrl, { atMs: now(), models });
      return models;
    } catch (error) {
      log('ai.llm.catalog.probe_failed', {
        base_url: baseUrl,
        error: error instanceof Error ? error.message : 'unknown',
      });
      cache.set(baseUrl, { atMs: now(), models: null });
      return null;
    }
  };

  return {
    async locate(servedModelId) {
      let simulatorUrl: string | null = null;
      for (const baseUrl of urls) {
        const models = await probe(baseUrl);
        if (models === null) continue;
        if (models.has(servedModelId)) return { baseUrl, servedModelId };
        if (simulatorUrl === null && models.has(SIMULATED_GOVERNANCE_LLM_MODEL_ID)) {
          simulatorUrl = baseUrl;
        }
      }
      // The DEV wildcard (see the header): the simulated runtime stands in for
      // any unlocated model, under its OWN served id.
      if (simulatorUrl !== null) {
        return { baseUrl: simulatorUrl, servedModelId: SIMULATED_GOVERNANCE_LLM_MODEL_ID };
      }
      return null;
    },
  };
}
