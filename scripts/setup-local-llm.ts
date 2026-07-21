// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `pnpm setup:llm` — provision + verify the governance-LLM LOCAL runtime
// (WS-U ADR-9, the role-split revision). Production defaults to the local
// backend when GOVERNANCE_LLM_PROVIDER is unset, running TWO model lanes:
//
//   moderation   — default Qwen/Qwen3Guard-Gen-4B  @ http://127.0.0.1:8001/v1
//   adjudication — default Qwen/Qwen3.6-27B        @ http://127.0.0.1:8002/v1
//                  (also serves the lawmaking summariser)
//
// The reviewed default RUNTIME is vLLM (one instance per lane; the compose
// `llm` profile provisions exactly the two defaults above and pulls the
// weights from huggingface.co on first start). `--runtime ollama` provisions
// the single-URL multiplexing alternative instead (one Ollama at
// http://127.0.0.1:11434/v1 serving GGUF builds of both models) and prints the
// env lines the API boot needs to match it.
//
// Steps:
//   1. resolve EXACTLY the lanes the API boot would resolve — the real
//      `resolveGovernanceLlmDecision` (the SSOT; honours every
//      GOVERNANCE_LLM_* key, applies the reviewed defaults, enforces the
//      loopback rule);
//   2. optionally start the repo's opt-in Compose runtime
//      (`--docker` ⇒ the `llm` profile for vLLM, `llm-ollama` for Ollama);
//   3. for an Ollama runtime, pull each lane's model when absent (streaming
//      progress); vLLM/llama.cpp/LM Studio load their model at launch;
//   4. verify each lane through the REAL completion path in its production
//      dialect — the moderation lane in its resolved format (the Qwen3Guard
//      native Safety/Categories block for guard models, strict JSON
//      otherwise), the adjudication lane against the real debate-adjudication
//      wire shape (schema + deterministic shell).
//
// Zero npm dependencies (global fetch + node built-ins); loopback-only by
// construction (step 1 rejects any non-loopback URL). Exit 0 ⇔ every lane is
// ready for the API boot.
//
// Usage:
//   pnpm setup:llm                      # verify the resolved vLLM lanes
//   pnpm setup:llm --docker             # first start the Compose `llm` profile (two vLLM instances)
//   pnpm setup:llm --runtime ollama     # the single-URL Ollama alternative (GGUF builds)
//   pnpm setup:llm --runtime ollama --docker
//   pnpm setup:llm --runtime ollama --moderation-model <ollama-name> --adjudication-model <ollama-name>

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  type GovernanceLlmLane,
  OLLAMA_LOOPBACK_URL,
  resolveGovernanceLlmDecision,
} from '../apps/api/src/ai-governance/llm/config.js';
import {
  ADMISSION_DEBATE_FIXTURE,
  boundDebateAssessment,
  buildDebateSystemPrompt,
  buildDebateUserPrompt,
  DEBATE_JSON_SCHEMA,
  debateLlmAssessmentSchema,
} from '../apps/api/src/ai-governance/llm/debate.js';
import {
  type ModerationOutputFormat,
  mapGuardVerdictToModeration,
  parseGuardVerdict,
} from '../apps/api/src/ai-governance/llm/guard-format.js';
import { createLocalCompletion } from '../apps/api/src/ai-governance/llm/local.js';
import {
  buildModerationSystemPrompt,
  buildModerationUserPrompt,
  MODERATION_JSON_SCHEMA,
  moderationVerdictSchema,
} from '../apps/api/src/ai-governance/llm/moderation.js';

const DOCKER_FLAG = '--docker';
/** How long to wait for a just-started container to begin listening. vLLM
 *  downloads the model weights from the hub on FIRST start (the 27B
 *  adjudication default is tens of GB), so the ceiling is generous — progress
 *  is visible via `docker compose logs -f`. */
const VLLM_STARTUP_WAIT_MS = 30 * 60_000;
const OLLAMA_STARTUP_WAIT_MS = 60_000;
/** First completion can include a cold model load into memory. */
const VERIFY_TIMEOUT_MS = 300_000;

/** The Ollama-alternative default models: community GGUF builds of the same
 *  two project-wide defaults (Ollama cannot serve safetensors repos directly).
 *  Overridable via --moderation-model / --adjudication-model or the env keys. */
const OLLAMA_DEFAULT_MODERATION_MODEL = 'hf.co/mradermacher/Qwen3Guard-Gen-4B-GGUF:Q8_0';
const OLLAMA_DEFAULT_ADJUDICATION_MODEL = 'hf.co/unsloth/Qwen3.6-27B-GGUF:Q4_K_M';

function info(message: string): void {
  console.log(`[setup:llm] ${message}`);
}

function fail(message: string): never {
  console.error(`[setup:llm] FAIL: ${message}`);
  process.exit(1);
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  // A missing value must FAIL, never silently fall back — and a following
  // flag must never be consumed as the value (`--moderation-model --docker`
  // would otherwise set the model to the literal string "--docker").
  if (value === undefined || value.startsWith('--')) {
    fail(`${name} requires a value`);
  }
  return value;
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

function stripSlash(url: string): string {
  let base = url;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return base;
}

async function isListening(baseUrl: string): Promise<boolean> {
  // Any HTTP answer (200/404/405/…) means a server holds the port; only a
  // connection-level failure means nothing is running there.
  return (
    (await tryFetch(`${stripSlash(baseUrl)}/models`, { method: 'GET', timeoutMs: 5_000 })) !== null
  );
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
 * Verify the MODERATION lane at full fidelity: the real `createLocalCompletion`
 * seam with the resolved settings, in the lane's PRODUCTION dialect — the
 * Qwen3Guard native Safety/Categories block (parsed + deterministically
 * mapped) for guard models, the strict-JSON verdict schema otherwise. Exit 0
 * means exactly "the boot's moderation path serves this runtime".
 */
async function verifyModerationLane(
  lane: GovernanceLlmLane,
  format: ModerationOutputFormat,
): Promise<void> {
  if (lane.backend.kind !== 'local') fail('unexpected backend kind');
  info(
    `verifying the MODERATION lane (${lane.settings.modelId}, ${format} dialect) — a cold model load can be slow…`,
  );
  const complete = createLocalCompletion(
    lane.backend.baseUrl,
    lane.settings,
    fetch,
    (event, meta) => info(`negotiated: ${event} ${JSON.stringify(meta)}`),
  );
  const benignContent = 'Thanks, this is a helpful and civil comment.';
  // The PRODUCTION prompt builders (not a paraphrase): exit 0 must mean
  // exactly "the boot's moderation path serves this runtime", byte-for-byte.
  const probeContext = {
    contentText: benignContent,
    contentKind: 'comment' as const,
    contentLength: benignContent.length,
    linkCount: 0,
    mentionCount: 0,
    hasMediaUpload: false,
    authorAccountAgeDays: 365,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
  };
  let result: Awaited<ReturnType<typeof complete>>;
  try {
    result = await complete({
      ...(format === 'qwen3guard'
        ? { user: benignContent }
        : {
            system: buildModerationSystemPrompt({ moderationPrompt: null }),
            user: buildModerationUserPrompt(probeContext),
            jsonSchema: MODERATION_JSON_SCHEMA,
          }),
      maxOutputTokens: lane.settings.maxOutputTokens,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
  } catch (error) {
    fail(
      `the real moderation completion failed: ${error instanceof Error ? error.message : String(error)} — is the model name correct for this runtime? (GOVERNANCE_LLM_MODERATION_MODEL)`,
    );
  }
  if (result.stopReason === 'refusal' || result.stopReason === 'max_tokens') {
    fail(`the runtime stopped with ${result.stopReason} instead of a verdict`);
  }
  const content = result.text;
  if (typeof content !== 'string' || content.length === 0) {
    fail('the runtime returned no completion content');
  }
  if (format === 'qwen3guard') {
    // Validate with the SAME parser + mapping the moderation proposer runs — an
    // unparseable guard block fails closed in production, so it must fail HERE.
    const guardVerdict = parseGuardVerdict(content);
    if (guardVerdict === null) {
      fail(
        'the runtime did not return a parseable Qwen3Guard Safety/Categories block — the moderation surface would fail closed on this runtime',
      );
    }
    const mapped = mapGuardVerdictToModeration(guardVerdict);
    info(`moderation lane OK (guard verdict: ${guardVerdict.safety} → ${mapped.action})`);
    return;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    fail('the runtime did not return the strict-JSON verdict the governed surfaces require');
  }
  const verdict = moderationVerdictSchema.safeParse(parsedJson);
  if (!verdict.success) {
    fail(
      `the runtime's verdict does not satisfy the governed moderation schema (${verdict.error.issues[0]?.message ?? 'invalid'}) — the moderation surface would fail closed on this runtime`,
    );
  }
  info(`moderation lane OK (probe verdict: ${verdict.data.action})`);
}

/**
 * Verify the ADJUDICATION lane against the real debate-adjudication wire
 * shape: the canonical admission fixture, the strict probabilities schema, and
 * the deterministic shell — exactly what `debate.judge` admission asserts.
 */
async function verifyAdjudicationLane(lane: GovernanceLlmLane): Promise<void> {
  if (lane.backend.kind !== 'local') fail('unexpected backend kind');
  info(`verifying the ADJUDICATION lane (${lane.settings.modelId}) against the debate wire shape…`);
  const complete = createLocalCompletion(
    lane.backend.baseUrl,
    lane.settings,
    fetch,
    (event, meta) => info(`negotiated: ${event} ${JSON.stringify(meta)}`),
  );
  let result: Awaited<ReturnType<typeof complete>>;
  try {
    result = await complete({
      system: buildDebateSystemPrompt(),
      user: buildDebateUserPrompt(ADMISSION_DEBATE_FIXTURE),
      maxOutputTokens: lane.settings.maxOutputTokens,
      jsonSchema: DEBATE_JSON_SCHEMA,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
  } catch (error) {
    fail(
      `the real adjudication completion failed: ${error instanceof Error ? error.message : String(error)} — is the model name correct for this runtime? (GOVERNANCE_LLM_ADJUDICATION_MODEL)`,
    );
  }
  if (result.stopReason === 'refusal' || result.stopReason === 'max_tokens') {
    fail(`the runtime stopped with ${result.stopReason} instead of an assessment`);
  }
  let assessment: unknown;
  try {
    assessment = JSON.parse(result.text ?? '');
  } catch {
    fail('the runtime did not return the strict-JSON debate assessment');
  }
  const parsed = debateLlmAssessmentSchema.safeParse(assessment);
  if (!parsed.success) {
    fail(
      `the runtime's assessment does not satisfy the debate schema (${parsed.error.issues[0]?.message ?? 'invalid'}) — the adjudication surface would fall back to the deterministic MLP on this runtime`,
    );
  }
  const verdict = boundDebateAssessment(parsed.data, 'setup-probe');
  if (verdict === null) {
    fail(
      'the runtime returned a degenerate/unusable assessment — the adjudication surface would fall back to the deterministic MLP on this runtime',
    );
  }
  info(`adjudication lane OK (probe verdict: ${verdict.verdict}/${verdict.winner})`);
}

async function main(): Promise<void> {
  const runtime = flagValue('--runtime') ?? 'vllm';
  if (runtime !== 'vllm' && runtime !== 'ollama') {
    fail(`unknown --runtime "${runtime}" (expected vllm or ollama)`);
  }
  const moderationOverride =
    flagValue('--moderation-model') ?? process.env['GOVERNANCE_LLM_MODERATION_MODEL'];
  const adjudicationOverride =
    flagValue('--adjudication-model') ?? process.env['GOVERNANCE_LLM_ADJUDICATION_MODEL'];

  // Step 1 — resolve the EXACT lanes the API boot would run (the SSOT). The
  // Ollama alternative overlays its single-URL + GGUF-build defaults; the env
  // lines the boot needs to match are printed at the end.
  const ollamaEnvOverrides =
    runtime === 'ollama'
      ? {
          localBaseUrl: process.env['GOVERNANCE_LLM_LOCAL_URL'] ?? OLLAMA_LOOPBACK_URL,
          moderationModelId: moderationOverride ?? OLLAMA_DEFAULT_MODERATION_MODEL,
          adjudicationModelId: adjudicationOverride ?? OLLAMA_DEFAULT_ADJUDICATION_MODEL,
        }
      : {
          localBaseUrl: process.env['GOVERNANCE_LLM_LOCAL_URL'],
          moderationModelId: moderationOverride,
          adjudicationModelId: adjudicationOverride,
        };
  const decision = resolveGovernanceLlmDecision({
    provider: 'local',
    apiKey: undefined,
    modelId: process.env['GOVERNANCE_LLM_MODEL'],
    moderationUrl: process.env['GOVERNANCE_LLM_MODERATION_URL'],
    adjudicationUrl: process.env['GOVERNANCE_LLM_ADJUDICATION_URL'],
    moderationFormat: process.env['GOVERNANCE_LLM_MODERATION_FORMAT'],
    // The probe must resolve the SAME settings the API boot will — including
    // the reasoning-effort lever — or setup could bless a runtime the real
    // wire shape then fails against.
    reasoningEffort: process.env['GOVERNANCE_LLM_REASONING_EFFORT'],
    ...ollamaEnvOverrides,
  });
  if (!decision.enabled) {
    fail(
      `the local backend cannot be enabled (${decision.reason}) — every GOVERNANCE_LLM_*_URL must be a loopback http(s) URL`,
    );
  }
  const { lanes, moderationFormat } = decision;
  if (lanes.moderation.backend.kind !== 'local' || lanes.adjudication.backend.kind !== 'local') {
    fail('unexpected backend kind');
  }
  const moderationUrl = stripSlash(lanes.moderation.backend.baseUrl);
  const adjudicationUrl = stripSlash(lanes.adjudication.backend.baseUrl);
  info(`runtime: ${runtime}`);
  info(
    `  moderation lane:   ${moderationUrl} · ${lanes.moderation.settings.modelId} (${moderationFormat})`,
  );
  info(`  adjudication lane: ${adjudicationUrl} · ${lanes.adjudication.settings.modelId}`);

  // Step 2 — optionally start the repo's Compose runtime.
  if (process.argv.includes(DOCKER_FLAG)) {
    // Name the services explicitly: a bare `--profile llm up -d` would ALSO
    // start the profile-less postgres/redis services on this host.
    const composeArgs =
      runtime === 'vllm'
        ? ['compose', '--profile', 'llm', 'up', '-d', 'vllm-moderation', 'vllm-adjudication']
        : ['compose', '--profile', 'llm-ollama', 'up', '-d', 'ollama'];
    info(`starting the Compose runtime (docker ${composeArgs.join(' ')})…`);
    const result = spawnSync('docker', composeArgs, { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      fail(`\`docker ${composeArgs.join(' ')}\` failed — is Docker installed and running?`);
    }
    const waitMs = runtime === 'vllm' ? VLLM_STARTUP_WAIT_MS : OLLAMA_STARTUP_WAIT_MS;
    if (runtime === 'vllm') {
      info(
        'waiting for the vLLM lanes (a FIRST start downloads the model weights from huggingface.co — the 27B adjudication model is tens of GB; follow along with `docker compose logs -f`)…',
      );
    }
    const deadline = Date.now() + waitMs;
    for (const url of new Set([moderationUrl, adjudicationUrl])) {
      while (!(await isListening(url))) {
        if (Date.now() > deadline) fail(`the container started but ${url} never began listening`);
        await sleep(5_000);
      }
      info(`  ${url} is listening`);
    }
  }

  // Step 3 — reachability, then the Ollama-only model pulls.
  for (const url of new Set([moderationUrl, adjudicationUrl])) {
    if (!(await isListening(url))) {
      fail(
        `nothing is listening at ${url}. Start a runtime first:\n` +
          `  pnpm setup:llm ${DOCKER_FLAG}                      (two vLLM lane instances)\n` +
          `  pnpm setup:llm --runtime ollama ${DOCKER_FLAG}     (single-URL Ollama alternative)\n` +
          '  — or natively: vLLM per lane, `ollama serve`, `llama-server -m <model>.gguf`, LM Studio\n' +
          '  — or point the GOVERNANCE_LLM_*_URL keys at your runtimes (loopback only)',
      );
    }
  }
  const pulls: Array<{ origin: string; modelId: string }> = [];
  for (const lane of [lanes.moderation, lanes.adjudication]) {
    if (lane.backend.kind !== 'local') continue;
    const origin = new URL(lane.backend.baseUrl).origin;
    if (await isOllama(origin)) {
      if (await ollamaHasModel(origin, lane.settings.modelId)) {
        info(`Ollama already has ${lane.settings.modelId}`);
      } else if (!pulls.some((p) => p.origin === origin && p.modelId === lane.settings.modelId)) {
        pulls.push({ origin, modelId: lane.settings.modelId });
      }
    }
  }
  for (const pull of pulls) await ollamaPull(pull.origin, pull.modelId);
  if (pulls.length === 0 && runtime === 'vllm') {
    info('vLLM loads its model at launch — no pull step; verifying directly');
  }

  // Step 4 — the authoritative end-to-end checks, one per lane.
  await verifyModerationLane(lanes.moderation, moderationFormat);
  await verifyAdjudicationLane(lanes.adjudication);

  info('READY — both lanes serve the governed surfaces.');
  if (runtime === 'ollama') {
    // The boot resolves the vLLM lane defaults unless told otherwise — an
    // Ollama deployment must pin these keys or the API will look at :8001/:8002.
    // Print the EXACT keys this run resolved with: when a per-lane URL key was
    // in the environment it OUTRANKED the legacy key during verification, so
    // persisting only the legacy line would target a runtime this run never
    // verified.
    info('IMPORTANT — persist these env lines so the API boot targets this Ollama runtime:');
    const moderationUrlOverride = process.env['GOVERNANCE_LLM_MODERATION_URL'];
    const adjudicationUrlOverride = process.env['GOVERNANCE_LLM_ADJUDICATION_URL'];
    info(`  GOVERNANCE_LLM_LOCAL_URL=${ollamaEnvOverrides.localBaseUrl}`);
    if (moderationUrlOverride !== undefined) {
      info(`  GOVERNANCE_LLM_MODERATION_URL=${moderationUrlOverride}`);
    }
    if (adjudicationUrlOverride !== undefined) {
      info(`  GOVERNANCE_LLM_ADJUDICATION_URL=${adjudicationUrlOverride}`);
    }
    info(`  GOVERNANCE_LLM_MODERATION_MODEL=${lanes.moderation.settings.modelId}`);
    info(`  GOVERNANCE_LLM_ADJUDICATION_MODEL=${lanes.adjudication.settings.modelId}`);
  }
  info(
    '(production defaults to the local backend; dev: set GOVERNANCE_LLM_PROVIDER=local to prefer it over the simulator)',
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
