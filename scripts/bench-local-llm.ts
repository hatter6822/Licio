// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `pnpm bench:llm [model …]` — race local models through the REAL governed
// LLM surfaces, PER ROLE, and report latency + validity per model. Nothing is
// reimplemented: each model runs the actual `createLocalCompletion` (with the
// per-runtime parameter negotiation), inside the actual governed executors —
// the in-room moderation proposer in the model's resolved DIALECT (the
// Qwen3Guard native Safety/Categories block for guard-family models, strict
// JSON otherwise), the WS-T debate adjudicator leg, and the lawmaking
// summariser with its §24.5 quality gate — over in-memory ai-governance
// services. A model "passes" a surface exactly when the production path would
// accept its output.
//
// The role split: `--role moderation` races candidates for the MODERATION
// lane (the moderation surface only), `--role adjudication` for the
// ADJUDICATION lane (debate + summary), and the default `all` runs every
// surface — useful when one model should serve both lanes (the single-runtime
// posture).
//
// With no model arguments, every model listed by the configured runtimes is
// benched (`GET /v1/models` — vLLM lists its one served model, Ollama lists
// every pulled model). The runtimes probed are the RESOLVED lane URLs (the
// same resolution the API boot runs) — override with the GOVERNANCE_LLM_*_URL
// env keys. When a model fails EVERY surface, a native sanity probe
// distinguishes an integration problem from a broken runtime/model pairing
// (e.g. a faulty GPU offload emitting garbage tokens) and prints the remedy.
//
// Usage:
//   pnpm bench:llm                                  # all listed models, every surface
//   pnpm bench:llm --role moderation                # moderation candidates only
//   pnpm bench:llm Qwen/Qwen3Guard-Gen-4B           # specific model(s)
//   pnpm bench:llm --runs 3                         # more warm runs per surface
//
// Exit 0 ⇔ every benched model passed every raced surface.

import process from 'node:process';
import {
  DEFAULT_GOVERNANCE_LLM_MODERATION_URL,
  type GovernanceLlmSettings,
  resolveGovernanceLlmDecision,
} from '../apps/api/src/ai-governance/llm/config.js';
import {
  ADMISSION_DEBATE_FIXTURE,
  createGovernanceLlmDebateJudge,
} from '../apps/api/src/ai-governance/llm/debate.js';
import { resolveModerationOutputFormat } from '../apps/api/src/ai-governance/llm/guard-format.js';
import { createLocalCompletion } from '../apps/api/src/ai-governance/llm/local.js';
import { createGovernanceLlmModerationProposer } from '../apps/api/src/ai-governance/llm/moderation.js';
import { createGovernanceLlmNlProvider } from '../apps/api/src/ai-governance/llm/provider.js';
import {
  buildGovernanceDebateJudgeIdentity,
  buildGovernanceLlmIdentity,
  buildGovernanceModerationProposerIdentity,
} from '../apps/api/src/ai-governance/llm/registration.js';
import { createInMemoryAiGovernanceServices } from '../apps/api/src/ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../apps/api/src/events/services.js';
import { parseGovernanceExtraRuntimeUrls } from '../packages/shared/src/env/server.js';

const args = process.argv.slice(2);
const runsFlag = args.indexOf('--runs');
const roleFlag = args.indexOf('--role');
// Flag values are VALIDATED, never silently defaulted: `--runs <model>` would
// otherwise swallow the model name (benching everything once instead of the
// named model), and a value-less `--role` would silently widen to `all`.
const runsValue = runsFlag !== -1 ? args[runsFlag + 1] : undefined;
if (runsFlag !== -1 && (runsValue === undefined || !/^\d+$/.test(runsValue))) {
  console.error(`--runs requires a positive integer (got ${JSON.stringify(runsValue ?? '')})`);
  process.exit(1);
}
const WARM_RUNS = runsValue !== undefined ? Math.max(1, Number(runsValue)) : 1;
const ROLE = roleFlag !== -1 ? args[roleFlag + 1] : 'all';
if (ROLE !== 'all' && ROLE !== 'moderation' && ROLE !== 'adjudication') {
  console.error(`unknown --role "${ROLE ?? ''}" (expected moderation, adjudication, or all)`);
  process.exit(1);
}
const MODELS = args.filter(
  (a, i) =>
    !a.startsWith('--') &&
    (runsFlag === -1 || i !== runsFlag + 1) &&
    (roleFlag === -1 || i !== roleFlag + 1),
);
const PARALLEL = 4;
const PARALLEL_SKIP_ABOVE_S = 12;

function log(line: string): void {
  console.log(line);
}

/** The lane URLs the API boot would resolve (env-honouring; loopback-only). */
function resolvedLaneUrls(): string[] {
  const decision = resolveGovernanceLlmDecision({
    provider: 'local',
    apiKey: undefined,
    modelId: process.env['GOVERNANCE_LLM_MODEL'],
    localBaseUrl: process.env['GOVERNANCE_LLM_LOCAL_URL'],
    moderationUrl: process.env['GOVERNANCE_LLM_MODERATION_URL'],
    adjudicationUrl: process.env['GOVERNANCE_LLM_ADJUDICATION_URL'],
    // The extra runtimes carry hub-candidate models — the boot resolution
    // folds them into runtimeUrls, and this resolver must match it or a
    // candidate served only on an extra runtime is invisible to the bench.
    extraRuntimeUrls: parseGovernanceExtraRuntimeUrls(
      process.env['GOVERNANCE_LLM_EXTRA_RUNTIME_URLS'],
    ),
    reasoningEffort: process.env['GOVERNANCE_LLM_REASONING_EFFORT'],
  });
  if (!decision.enabled) throw new Error(`decision disabled: ${decision.reason}`);
  return decision.runtimeUrls;
}

// --- fixtures (the same shapes the test suites pin) ---------------------------

const BENIGN_CONTEXT = {
  contentText: 'Thanks, this is a helpful and civil comment.',
  contentKind: 'comment' as const,
  contentLength: 44,
  linkCount: 0,
  mentionCount: 0,
  hasMediaUpload: false,
  authorAccountAgeDays: 365,
  authorNewToRoom: false,
  priorRemovalsInRoom: 0,
};

const PROPOSAL = {
  proposalId: 'bench-proposal',
  title: 'Adopt a weekly community digest',
  body: 'Members propose an opt-in weekly digest summarising the most-discussed threads of the week for every subscriber.',
  options: ['Adopt', 'Reject'],
};

// --- harness ------------------------------------------------------------------

interface SurfaceResult {
  coldS: number;
  warmS: number;
  outcome: string;
  pass: boolean;
}

function benchSettings(modelId: string, baseUrl: string): GovernanceLlmSettings {
  const decision = resolveGovernanceLlmDecision({
    provider: 'local',
    apiKey: undefined,
    modelId,
    localBaseUrl: baseUrl,
    reasoningEffort: process.env['GOVERNANCE_LLM_REASONING_EFFORT'],
  });
  if (!decision.enabled) throw new Error(`decision disabled: ${decision.reason}`);
  return {
    ...decision.lanes.moderation.settings,
    // Benchmark posture: never trip the shared budget/breaker mid-run, and give
    // slow dense models room (these are BENCH settings, not production ones).
    timeoutMs: 600_000,
    moderationTimeoutMs: 600_000,
    maxCallsPerRoomPerHour: 100_000,
    maxModerationCallsPerRoomPerHour: 100_000,
    maxDebateJudgementsPerHour: 100_000,
    breakerFailureThreshold: 100_000,
  };
}

async function timeSurface(
  runs: number,
  once: () => Promise<{ pass: boolean; outcome: string }>,
): Promise<SurfaceResult> {
  const t0 = Date.now();
  let last = await once();
  const coldS = (Date.now() - t0) / 1000;
  let warmTotal = 0;
  for (let i = 0; i < runs; i += 1) {
    const w0 = Date.now();
    last = await once();
    warmTotal += Date.now() - w0;
  }
  return { coldS, warmS: warmTotal / runs / 1000, ...last };
}

/** Below-the-governed-API sanity probe: Ollama's native /api/chat when the
 *  runtime is Ollama, a plain schema-less /v1/chat/completions otherwise. */
async function nativeSanityProbe(baseUrl: string, modelId: string): Promise<string> {
  const origin = new URL(baseUrl).origin;
  try {
    const version = await fetch(`${origin}/api/version`, {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (version?.ok === true) {
      const response = await fetch(`${origin}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({
          model: modelId,
          stream: false,
          messages: [{ role: 'user', content: 'Say hello in three words.' }],
          options: { num_predict: 24 },
        }),
        signal: AbortSignal.timeout(300_000),
      });
      const data = (await response.json()) as { message?: { content?: string } };
      return data.message?.content ?? '';
    }
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 24,
        messages: [{ role: 'user', content: 'Say hello in three words.' }],
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    return data.choices?.[0]?.message?.content ?? '';
  } catch (error) {
    return `native probe failed: ${String(error)}`;
  }
}

async function benchModel(modelId: string, baseUrl: string): Promise<boolean> {
  const format = resolveModerationOutputFormat(modelId);
  log(`\n=== ${modelId} @ ${baseUrl}${ROLE === 'all' ? '' : ` (role: ${ROLE})`} ===`);
  if (ROLE !== 'adjudication' && format === 'qwen3guard') {
    log('  guard-family model — the moderation surface runs its NATIVE dialect');
  }
  const settings = benchSettings(modelId, baseUrl);
  const services = createInMemoryAiGovernanceServices(createInMemoryEventPipelineServices(), {});
  const backend = { kind: 'local', baseUrl } as const;
  const complete = createLocalCompletion(baseUrl, settings, fetch, (event, meta) =>
    log(`    negotiated: ${event} ${JSON.stringify(meta)}`),
  );

  const proposer = createGovernanceLlmModerationProposer({
    services,
    settings,
    identity: buildGovernanceModerationProposerIdentity(settings, backend, format),
    complete,
    format,
  });
  const judge = createGovernanceLlmDebateJudge({
    services,
    settings,
    identity: buildGovernanceDebateJudgeIdentity(settings, backend),
    complete,
  });
  const summariser = createGovernanceLlmNlProvider({
    services,
    settings,
    identity: buildGovernanceLlmIdentity(settings, backend),
    complete,
  });

  const allSurfaces: Record<string, () => Promise<{ pass: boolean; outcome: string }>> = {
    moderation: async () => {
      const result = await proposer.propose({
        roomId: 'bench',
        subjectRef: `m-${Math.random().toString(36).slice(2)}`,
        context: BENIGN_CONTEXT,
        moderationPrompt: null,
        modelRef: null,
      });
      return result.status === 'decided'
        ? { pass: true, outcome: result.proposal.action }
        : { pass: false, outcome: `unavailable:${result.code}` };
    },
    debate: async () => {
      const outcome = await judge(
        `d-${Math.random().toString(36).slice(2)}`,
        ADMISSION_DEBATE_FIXTURE,
      );
      return outcome !== null
        ? { pass: true, outcome: `${outcome.verdict.verdict}/${outcome.verdict.winner}` }
        : { pass: false, outcome: 'unavailable' };
    },
    summary: async () => {
      try {
        const summary = await summariser.summarizeProposal({
          roomId: 'bench',
          proposal: PROPOSAL,
          roomPromptText: null,
          promptTemplate: null,
          summaryStyle: 'neutral_brief',
          adjudicationRef: null,
        });
        return { pass: true, outcome: `headline ${summary.headline.length} chars` };
      } catch (error) {
        const code = (error as { code?: string }).code ?? String(error).slice(0, 40);
        return { pass: false, outcome: `failed:${code}` };
      }
    },
  };
  // The role split: moderation candidates race the moderation surface;
  // adjudication candidates race debate + summary (the adjudication lane
  // serves both); `all` races everything (the single-runtime posture).
  const surfaces = Object.fromEntries(
    Object.entries(allSurfaces).filter(([name]) =>
      ROLE === 'all' ? true : ROLE === 'moderation' ? name === 'moderation' : name !== 'moderation',
    ),
  );

  const results = new Map<string, SurfaceResult>();
  for (const [name, once] of Object.entries(surfaces)) {
    results.set(name, await timeSurface(WARM_RUNS, once));
    const r = results.get(name);
    log(
      `  ${name.padEnd(11)} cold ${r?.coldS.toFixed(1).padStart(6)}s  warm ${r?.warmS
        .toFixed(2)
        .padStart(7)}s  ${r?.pass ? 'PASS' : 'FAIL'}  ${r?.outcome}`,
    );
  }

  // Debate is the scale-relevant surface: burst it when the model is fast
  // enough for parallelism to matter.
  const debate = results.get('debate');
  if (debate?.pass && debate.warmS <= PARALLEL_SKIP_ABOVE_S) {
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: PARALLEL }, () => surfaces['debate']?.()).filter(Boolean),
    );
    const burstS = (Date.now() - t0) / 1000;
    log(
      `  ${PARALLEL}-parallel debate burst: ${burstS.toFixed(2)}s total (${(burstS / PARALLEL).toFixed(2)}s effective/verdict)`,
    );
  }

  const allPass = [...results.values()].every((r) => r.pass);
  if (!allPass && [...results.values()].every((r) => !r.pass)) {
    // Every surface failed — is the runtime/model pairing itself broken?
    const native = await nativeSanityProbe(baseUrl, modelId);
    const looksBroken = native.length === 0 || native.includes('<unused');
    log(
      looksBroken
        ? `  DIAGNOSIS: the runtime/model pairing is broken below the OpenAI-compat API (native probe: ${JSON.stringify(native.slice(0, 40))}). This is typically a faulty GPU-offload path. Remedy (Ollama): pin the model to CPU —\n    printf 'FROM ${modelId}\\nPARAMETER num_gpu 0\\n' | ollama create ${modelId.replace(/[:/]/g, '-')}-cpu -f -\n  then bench the -cpu variant; on vLLM, check the container logs for load/OOM errors.`
        : `  DIAGNOSIS: the model responds natively (${JSON.stringify(native.slice(0, 40))}) but fails the governed wire shape — likely a structured-output or budget incompatibility; re-run with GOVERNANCE_LLM_REASONING_EFFORT=none or off.`,
    );
  }
  return allPass;
}

/** List the models a runtime serves (`GET /v1/models` — vLLM and Ollama both
 *  answer it; the OpenAI-standard listing replaces the Ollama-only /api/tags). */
async function listModels(baseUrl: string): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

async function main(): Promise<void> {
  const urls = resolvedLaneUrls();
  // Map each model to the FIRST runtime that lists it (lane precedence order).
  const located = new Map<string, string>();
  for (const url of urls) {
    for (const id of await listModels(url).catch(() => [] as string[])) {
      if (!located.has(id)) located.set(id, url);
    }
  }
  let targets: Array<{ modelId: string; baseUrl: string }>;
  if (MODELS.length > 0) {
    targets = MODELS.map((modelId) => ({
      modelId,
      baseUrl: located.get(modelId) ?? urls[0] ?? DEFAULT_GOVERNANCE_LLM_MODERATION_URL,
    }));
  } else {
    targets = [...located.entries()].map(([modelId, baseUrl]) => ({ modelId, baseUrl }));
    if (targets.length === 0) {
      throw new Error(
        `no models listed by any configured runtime (${urls.join(', ')}) — run \`pnpm setup:llm\` first`,
      );
    }
  }
  log(
    `bench:llm — ${targets.length} model(s) across ${urls.length} runtime(s), role: ${ROLE} (${WARM_RUNS} warm run(s)/surface)`,
  );
  const failures: string[] = [];
  for (const target of targets) {
    try {
      if (!(await benchModel(target.modelId, target.baseUrl))) failures.push(target.modelId);
    } catch (error) {
      log(`  FAILED to bench: ${error instanceof Error ? error.message : String(error)}`);
      failures.push(target.modelId);
    }
  }
  log(
    failures.length === 0
      ? `\nALL PASS — every model served every raced surface.`
      : `\nFAILURES: ${failures.join(', ')}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`bench:llm failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
