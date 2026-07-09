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
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Join the operator-configured base URL (e.g. http://127.0.0.1:11434/v1)
 *  with the chat-completions path, tolerating trailing slashes. */
export function localChatCompletionsUrl(baseUrl: string): string {
  let base = baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/chat/completions`;
}

/** Build the local completion over the OpenAI-compatible protocol. */
export function createLocalCompletion(
  baseUrl: string,
  settings: GovernanceLlmSettings,
  fetchImpl: FetchLike = fetch,
): LlmCompletion {
  const url = localChatCompletionsUrl(baseUrl);
  return async (request) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: settings.modelId,
        max_tokens: request.maxOutputTokens,
        // Local runtimes accept temperature; 0 minimises variance on this
        // extractive task (the hosted Claude leg intentionally sends none —
        // current Claude models reject sampling parameters).
        temperature: 0,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'lawmaking_summary', strict: true, schema: request.jsonSchema },
        },
      }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`local inference server responded ${response.status}`);
    }
    const data: unknown = await response.json();
    const parsed = localChatCompletionSchema.parse(data);
    const choice = parsed.choices[0];
    if (!choice) throw new Error('local inference server returned no choices');
    return {
      stopReason: mapFinishReason(choice.finish_reason),
      text: choice.message.content,
    };
  };
}
