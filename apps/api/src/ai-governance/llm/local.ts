// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The SAME-HOST local inference completion (WS-U ADR-9 'local' backend): a
// zero-dependency fetch client for the OpenAI-compatible /chat/completions
// protocol that llama.cpp server, Ollama, vLLM, and LM Studio all speak — one
// adapter covers every common local runtime. The base URL is loopback-only
// (enforced at env validation AND in the enablement decision), so this backend
// provably sends no content off-host. The JSON-schema response_format is sent
// as a constraint but NEVER trusted: the provider re-validates with zod and the
// deterministic quality gate either way, so a runtime that ignores — or hard-
// rejects — the format degrades safely to the deterministic summary.

import { z } from 'zod';
import type { GovernanceLlmSettings } from './config.js';
import type { LlmCompletion } from './provider.js';

/** The minimal OpenAI-compatible response surface consumed here (zod at the
 *  external trust boundary; unknown fields are stripped). */
const localChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
});

/** OpenAI-compatible finish reasons, mapped onto the provider's stop-reason
 *  vocabulary ('refusal' and 'max_tokens' are the load-bearing branches). */
function mapFinishReason(finishReason: string | null | undefined): string | null {
  if (finishReason === undefined || finishReason === null) return null;
  if (finishReason === 'stop') return 'end_turn';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  return finishReason;
}

/** The narrow fetch surface (tests inject a fake; the global fetch satisfies
 *  it structurally — Node 22, no dependency). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    /** Loopback egress guarantee: a redirect must FAIL, never be followed off-host. */
    redirect: 'error';
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Join the operator-configured base URL (e.g. http://127.0.0.1:11434/v1)
 *  with the chat-completions path, tolerating trailing slashes. */
export function localChatCompletionsUrl(baseUrl: string): string {
  let base = baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/chat/completions`;
}

/** Metadata-only observability hook for the negotiation latches below. */
export type LocalCompletionLog = (event: string, meta: Record<string, unknown>) => void;

/**
 * Build the local completion over the OpenAI-compatible protocol, with
 * PER-RUNTIME PARAMETER NEGOTIATION for the `reasoning_effort` lever (each
 * model family behaves differently, all measured on real runtimes):
 *
 *   - a runtime/model that REJECTS the field with HTTP 400 (e.g. gemma3 —
 *     "model does not support reasoning") gets ONE retry without it, and the
 *     omission is LATCHED for the closure's lifetime;
 *   - a reasoning model whose thinking EXHAUSTS the output budget before any
 *     content (finish_reason `length` with an empty message — the qwen3
 *     family at any effort above `none`) gets ONE retry at `none`, latched.
 *
 * Every adaptation is logged (metadata only) — never silent. The DECLARED
 * effort stays the config-hashed decision surface: it is the most reasoning
 * the platform requests, and a runtime that cannot honour it serves the
 * lesser-thinking form with every deterministic gate still judging the output
 * above this layer. At most one retry per call; a latched closure sends its
 * adapted form directly on subsequent calls.
 */
export function createLocalCompletion(
  baseUrl: string,
  settings: GovernanceLlmSettings,
  fetchImpl: FetchLike = fetch,
  log: LocalCompletionLog = () => {},
): LlmCompletion {
  const url = localChatCompletionsUrl(baseUrl);
  /** The negotiated effort actually sent (starts at the declared setting). */
  let effectiveEffort: GovernanceLlmSettings['reasoningEffort'] = settings.reasoningEffort;
  /** True once the runtime 400-rejected the field (never send it again). */
  let effortRejected = false;

  const attempt = async (
    request: Parameters<LlmCompletion>[0],
    effort: GovernanceLlmSettings['reasoningEffort'],
  ) => {
    return fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A loopback server that answers with a 3xx redirect must NOT have this POST
      // body (governed proposal/contribution text) replayed to the Location — that
      // would send content off-host despite the loopback-only guarantee. Fail closed
      // (WS-U ADR-9 review); the provider then degrades to the deterministic path.
      redirect: 'error',
      body: JSON.stringify({
        model: settings.modelId,
        max_tokens: request.maxOutputTokens,
        // Local runtimes accept temperature; 0 minimises variance on this
        // extractive task (the hosted Claude leg intentionally sends none —
        // current Claude models reject sampling parameters).
        temperature: 0,
        // Reasoning-model latency lever. Config-hashed into the identity, so
        // changing the DECLARED value re-clears the WS-K gate. Null ⇒ not sent.
        ...(effort !== null && !effortRejected ? { reasoning_effort: effort } : {}),
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'lawmaking_summary', strict: true, schema: request.jsonSchema },
        },
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? settings.timeoutMs),
    });
  };

  const toResult = async (response: Awaited<ReturnType<FetchLike>>) => {
    const data: unknown = await response.json();
    const parsed = localChatCompletionSchema.parse(data);
    const choice = parsed.choices[0];
    if (!choice) throw new Error('local inference server returned no choices');
    return {
      stopReason: mapFinishReason(choice.finish_reason),
      text: choice.message.content,
    };
  };

  return async (request) => {
    let response = await attempt(request, effectiveEffort);

    // Negotiation 1 — the runtime rejects the reasoning_effort field outright.
    if (response.status === 400 && effectiveEffort !== null && !effortRejected) {
      effortRejected = true;
      log('ai.llm.local.effort_rejected', { model_id: settings.modelId });
      response = await attempt(request, null);
    }
    if (!response.ok) {
      throw new Error(`local inference server responded ${response.status}`);
    }
    let result = await toResult(response);

    // Negotiation 2 — thinking exhausted the whole output budget before any
    // content. Retry once with thinking disabled and latch. Only when the
    // operator DECLARED an effort at all: an explicit `off` (null) is a strict
    // never-send-the-field instruction and is honoured verbatim.
    if (
      result.stopReason === 'max_tokens' &&
      (result.text === null || result.text.length === 0) &&
      settings.reasoningEffort !== null &&
      effectiveEffort !== 'none' &&
      !effortRejected
    ) {
      effectiveEffort = 'none';
      log('ai.llm.local.thinking_exhausted', { model_id: settings.modelId });
      const retried = await attempt(request, effectiveEffort);
      if (!retried.ok) {
        throw new Error(`local inference server responded ${retried.status}`);
      }
      result = await toResult(retried);
    }
    return result;
  };
}
