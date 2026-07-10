// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `pnpm setup:llm` — provision + verify the governance-LLM LOCAL runtime
// (WS-U ADR-9 slice 3). Production defaults to this backend when
// GOVERNANCE_LLM_PROVIDER is unset, so a production (or real-LLM dev) box
// needs an OpenAI-compatible inference server on the loopback interface
// serving the configured model. This script makes that true end to end:
//
//   1. resolves EXACTLY the backend the API boot would resolve — it calls the
//      real `resolveGovernanceLlmDecision` (the SSOT; honours
//      GOVERNANCE_LLM_LOCAL_URL / GOVERNANCE_LLM_MODEL, applies the reviewed
//      defaults, enforces the loopback rule);
//   2. optionally starts the repo's opt-in Compose runtime
//      (`--docker` ⇒ `docker compose --profile llm up -d ollama`);
//   3. if the runtime is Ollama, pulls the configured model when absent
//      (streaming progress); other runtimes (llama.cpp server, vLLM,
//      LM Studio) load models at launch, so the pull step is skipped;
//   4. verifies a REAL /chat/completions round-trip with the same strict-JSON
//      response_format the governed surfaces send.
//
// Zero npm dependencies (global fetch + node built-ins); loopback-only by
// construction (step 1 rejects any non-loopback URL). Exit 0 ⇔ the runtime is
// ready for the API boot.
//
// Usage:
//   pnpm setup:llm             # check + pull + verify against the resolved URL
//   pnpm setup:llm --docker    # first start the Compose `llm` profile runtime

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  type GovernanceLlmSettings,
  resolveGovernanceLlmDecision,
} from '../apps/api/src/ai-governance/llm/config.js';
import { createLocalCompletion } from '../apps/api/src/ai-governance/llm/local.js';
import {
  MODERATION_JSON_SCHEMA,
  moderationVerdictSchema,
} from '../apps/api/src/ai-governance/llm/moderation.js';

const DOCKER_FLAG = '--docker';
/** How long to wait for a just-started container to begin listening. */
const STARTUP_WAIT_MS = 60_000;
/** First completion can include a cold model load into memory. */
const VERIFY_TIMEOUT_MS = 300_000;

function info(message: string): void {
  console.log(`[setup:llm] ${message}`);
}

function fail(message: string): never {
  console.error(`[setup:llm] FAIL: ${message}`);
  process.exit(1);
}

/** A fetch that resolves null on CONNECTION-level failure (nothing listening)
 *  but returns any HTTP response, whatever the status — "listening" and
 *  "endpoint exists" are separate questions during setup. */
async function tryFetch(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response | null> {
  try {
    const { timeoutMs, ...rest } = init;
    return await fetch(url, { ...rest, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isListening(baseUrl: string): Promise<boolean> {
  // Any HTTP answer (200/404/405/…) means a server holds the port; only a
  // connection-level failure means nothing is running there.
  return (await tryFetch(`${baseUrl}/models`, { method: 'GET', timeoutMs: 5_000 })) !== null;
}

async function isOllama(origin: string): Promise<boolean> {
  const response = await tryFetch(`${origin}/api/version`, { method: 'GET', timeoutMs: 5_000 });
  return response?.ok === true;
}

async function ollamaHasModel(origin: string, modelId: string): Promise<boolean> {
  const response = await tryFetch(`${origin}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId }),
    timeoutMs: 10_000,
  });
  return response?.ok === true;
}

/** Stream `ollama pull` progress (NDJSON status lines) to the console. */
async function ollamaPull(origin: string, modelId: string): Promise<void> {
  info(`pulling ${modelId} (this downloads the model weights; it can take a while)…`);
  const response = await fetch(`${origin}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, stream: true }),
    redirect: 'error',
  });
  if (!response.ok || response.body === null) {
    fail(`the runtime rejected the pull of ${modelId} (HTTP ${response.status})`);
  }
  const decoder = new TextDecoder();
  let buffered = '';
  let lastPrinted = '';
  let lastPercentAt = 0;
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (line.length === 0) continue;
      let event: { status?: string; error?: string; completed?: number; total?: number };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.error) fail(`pull failed: ${event.error}`);
      const status = event.status ?? '';
      if (status !== lastPrinted) {
        info(`  ${status}`);
        lastPrinted = status;
      } else if (
        typeof event.completed === 'number' &&
        typeof event.total === 'number' &&
        event.total > 0 &&
        Date.now() - lastPercentAt > 5_000
      ) {
        info(`  ${status} — ${Math.floor((event.completed / event.total) * 100)}%`);
        lastPercentAt = Date.now();
      }
    }
  }
  info(`pull of ${modelId} complete`);
}

/**
 * The authoritative check, at FULL FIDELITY: the verification runs through the
 * REAL `createLocalCompletion` seam with the RESOLVED settings — including
 * `reasoning_effort` and the per-runtime parameter negotiation — so exit 0
 * means exactly "the boot's completion path serves this runtime". (An earlier
 * hand-rolled probe here omitted `reasoning_effort` and would have passed a
 * runtime that then rejected the real wire shape.)
 */
async function verifyChatCompletion(
  baseUrl: string,
  settings: GovernanceLlmSettings,
): Promise<void> {
  info(
    `verifying a /chat/completions round-trip with ${settings.modelId} (a cold model load can be slow)…`,
  );
  const complete = createLocalCompletion(baseUrl, settings, fetch, (event, meta) =>
    info(`negotiated: ${event} ${JSON.stringify(meta)}`),
  );
  let result: Awaited<ReturnType<typeof complete>>;
  try {
    result = await complete({
      system:
        'You are a content-moderation classifier. Respond with a single JSON object: {"action": one of allow/warn/flag_for_review/restrict/remove, "reason": string}.',
      user: [
        'Classify the contribution below.',
        '<contribution>',
        'kind: comment',
        'links: 0',
        'text:',
        'Thanks, this is a helpful and civil comment.',
        '</contribution>',
      ].join('\n'),
      maxOutputTokens: settings.maxOutputTokens,
      jsonSchema: MODERATION_JSON_SCHEMA,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
  } catch (error) {
    fail(
      `the real completion path failed: ${error instanceof Error ? error.message : String(error)} — is the model name correct for this runtime? (GOVERNANCE_LLM_MODEL)`,
    );
  }
  if (result.stopReason === 'refusal' || result.stopReason === 'max_tokens') {
    fail(`the runtime stopped with ${result.stopReason} instead of a verdict`);
  }
  const content = result.text;
  if (typeof content !== 'string' || content.length === 0) {
    fail('the runtime returned no completion content');
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    fail('the runtime did not return the strict-JSON verdict the governed surfaces require');
  }
  // Validate with the SAME schema the moderation proposer enforces (the closed
  // action enum + a bounded reason) — a runtime that emits `{"action":
  // "allowed"}` or omits `reason` would fail closed in production, so it must
  // fail HERE, not after deployment.
  const verdict = moderationVerdictSchema.safeParse(parsedJson);
  if (!verdict.success) {
    fail(
      `the runtime's verdict does not satisfy the governed moderation schema (${verdict.error.issues[0]?.message ?? 'invalid'}) — the moderation surface would fail closed on this runtime`,
    );
  }
  info(`verification completion OK (probe verdict: ${verdict.data.action})`);
}

async function main(): Promise<void> {
  // Step 1 — resolve the EXACT backend the API boot would run (the SSOT).
  const decision = resolveGovernanceLlmDecision({
    provider: 'local',
    apiKey: undefined,
    modelId: process.env['GOVERNANCE_LLM_MODEL'],
    localBaseUrl: process.env['GOVERNANCE_LLM_LOCAL_URL'],
    // The probe must resolve the SAME settings the API boot will — including
    // the reasoning-effort lever — or setup could bless a runtime the real
    // wire shape then fails against.
    reasoningEffort: process.env['GOVERNANCE_LLM_REASONING_EFFORT'],
  });
  if (!decision.enabled) {
    fail(
      `the local backend cannot be enabled (${decision.reason}) — GOVERNANCE_LLM_LOCAL_URL must be a loopback http(s) URL`,
    );
  }
  if (decision.backend.kind !== 'local') fail('unexpected backend kind');
  let baseUrl = decision.backend.baseUrl;
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
  const modelId = decision.settings.modelId;
  const origin = new URL(baseUrl).origin;
  info(`target runtime: ${baseUrl} · model: ${modelId}`);

  // Step 2 — optionally start the repo's Compose runtime.
  if (process.argv.includes(DOCKER_FLAG)) {
    info('starting the Compose `llm` profile runtime (docker compose --profile llm up -d ollama)…');
    const result = spawnSync('docker', ['compose', '--profile', 'llm', 'up', '-d', 'ollama'], {
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) {
      fail('`docker compose --profile llm up -d ollama` failed — is Docker installed and running?');
    }
    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (!(await isListening(baseUrl))) {
      if (Date.now() > deadline) fail(`the container started but ${baseUrl} never began listening`);
      await sleep(2_000);
    }
  }

  // Step 3 — reachability, then the Ollama-only model pull.
  if (!(await isListening(baseUrl))) {
    fail(
      `nothing is listening at ${baseUrl}. Start a runtime first:\n` +
        `  docker compose --profile llm up -d ollama   (or: pnpm setup:llm ${DOCKER_FLAG})\n` +
        '  — or natively: `ollama serve`, `llama-server -m <model>.gguf`, vLLM, LM Studio\n' +
        '  — or point GOVERNANCE_LLM_LOCAL_URL at your runtime (loopback only)',
    );
  }
  if (await isOllama(origin)) {
    if (await ollamaHasModel(origin, modelId)) {
      info(`Ollama already has ${modelId}`);
    } else {
      await ollamaPull(origin, modelId);
    }
  } else {
    info(
      'runtime is not Ollama (no /api/version) — skipping the pull step (llama.cpp/vLLM/LM Studio load their model at launch); verifying directly',
    );
  }

  // Step 4 — the authoritative end-to-end check.
  await verifyChatCompletion(baseUrl, decision.settings);
  info(
    `READY — the API boot will use this runtime (production defaults to it; ` +
      `dev: set GOVERNANCE_LLM_PROVIDER=local to prefer it over the simulator).`,
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
