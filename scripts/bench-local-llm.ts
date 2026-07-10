// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `pnpm bench:llm [model …]` — race local models through the REAL governed
// LLM surfaces and report latency + validity per model. Nothing is
// reimplemented: each model runs the actual `createLocalCompletion` (with the
// per-runtime parameter negotiation), inside the actual governed executors —
// the in-room moderation proposer, the WS-T debate adjudicator leg, and the
// lawmaking summariser with its §24.5 quality gate — over in-memory
// ai-governance services. A model "passes" a surface exactly when the
// production path would accept its output.
//
// With no model arguments, every model installed on the runtime is benched
// (Ollama's /api/tags; pass names explicitly for other runtimes). When a
// model fails EVERY surface, a native-API sanity probe distinguishes an
// integration problem from a broken runtime/model pairing (e.g. a faulty GPU
// offload emitting garbage tokens) and prints the remedy.
//
// Usage:
//   pnpm bench:llm                       # all installed models, 1 warm run each
//   pnpm bench:llm gpt-oss:20b qwen3:30b # specific models
//   pnpm bench:llm --runs 3              # more warm runs per surface
//
// Exit 0 ⇔ every benched model passed every surface.

import process from 'node:process';
import type { DebateJudgeInput } from '@licio/shared';
import {
  type GovernanceLlmSettings,
  resolveGovernanceLlmDecision,
} from '../apps/api/src/ai-governance/llm/config.js';
import { createGovernanceLlmDebateJudge } from '../apps/api/src/ai-governance/llm/debate.js';
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

const args = process.argv.slice(2);
const runsFlag = args.indexOf('--runs');
const WARM_RUNS = runsFlag !== -1 ? Math.max(1, Number(args[runsFlag + 1]) || 1) : 1;
const MODELS = args.filter(
  (a, i) => !a.startsWith('--') && (runsFlag === -1 || i !== runsFlag + 1),
);
const BASE_URL = process.env['GOVERNANCE_LLM_LOCAL_URL'] ?? 'http://127.0.0.1:11434/v1';
const ORIGIN = new URL(BASE_URL).origin;
const PARALLEL = 4;
const PARALLEL_SKIP_ABOVE_S = 12;

function log(line: string): void {
  console.log(line);
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

const DEBATE_INPUT: DebateJudgeInput = {
  incumbent: {
    summary:
      'The stated admission figure comes directly from the certified quarterly totals; the original claim stands as written.',
    sources: [
      {
        url: 'https://harborledger.example/health/figures',
        domain: 'harborledger.example',
        link_safe: true,
        reliability: 0.55,
      },
    ],
    rebuts_opponent: false,
  },
  challenger: {
    summary:
      'The stated figure does not match the primary series: the linked reports cover the same admissions dataset and land outside the published interval for the quarter cited, so the claim as written needs correcting.',
    sources: [
      {
        url: 'https://civicregister.example/refs/health-1',
        domain: 'civicregister.example',
        link_safe: true,
        reliability: 0.9,
      },
      {
        url: 'https://northbulletin.example/refs/health-2',
        domain: 'northbulletin.example',
        link_safe: true,
        reliability: 0.8,
      },
      {
        url: 'https://metroreview.example/refs/health-3',
        domain: 'metroreview.example',
        link_safe: true,
        reliability: 0.85,
      },
    ],
    rebuts_opponent: true,
  },
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

function benchSettings(modelId: string): GovernanceLlmSettings {
  const decision = resolveGovernanceLlmDecision({
    provider: 'local',
    apiKey: undefined,
    modelId,
    localBaseUrl: BASE_URL,
    reasoningEffort: process.env['GOVERNANCE_LLM_REASONING_EFFORT'],
  });
  if (!decision.enabled) throw new Error(`decision disabled: ${decision.reason}`);
  return {
    ...decision.settings,
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

async function nativeSanityProbe(modelId: string): Promise<string> {
  try {
    const response = await fetch(`${ORIGIN}/api/chat`, {
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
  } catch (error) {
    return `native probe failed: ${String(error)}`;
  }
}

async function benchModel(modelId: string): Promise<boolean> {
  log(`\n=== ${modelId} ===`);
  const settings = benchSettings(modelId);
  const services = createInMemoryAiGovernanceServices(createInMemoryEventPipelineServices(), {});
  const backend = { kind: 'local', baseUrl: BASE_URL } as const;
  const complete = createLocalCompletion(BASE_URL, settings, fetch, (event, meta) =>
    log(`    negotiated: ${event} ${JSON.stringify(meta)}`),
  );

  const proposer = createGovernanceLlmModerationProposer({
    services,
    settings,
    identity: buildGovernanceModerationProposerIdentity(settings, backend),
    complete,
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

  const surfaces: Record<string, () => Promise<{ pass: boolean; outcome: string }>> = {
    moderation: async () => {
      const result = await proposer.propose({
        roomId: 'bench',
        subjectRef: `m-${Math.random().toString(36).slice(2)}`,
        context: BENIGN_CONTEXT,
        moderationPrompt: null,
      });
      return result.status === 'decided'
        ? { pass: true, outcome: result.proposal.action }
        : { pass: false, outcome: `unavailable:${result.code}` };
    },
    debate: async () => {
      const outcome = await judge(`d-${Math.random().toString(36).slice(2)}`, DEBATE_INPUT);
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
        });
        return { pass: true, outcome: `headline ${summary.headline.length} chars` };
      } catch (error) {
        const code = (error as { code?: string }).code ?? String(error).slice(0, 40);
        return { pass: false, outcome: `failed:${code}` };
      }
    },
  };

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
    const native = await nativeSanityProbe(modelId);
    const looksBroken = native.length === 0 || native.includes('<unused');
    log(
      looksBroken
        ? `  DIAGNOSIS: the runtime/model pairing is broken below the OpenAI-compat API (native probe: ${JSON.stringify(native.slice(0, 40))}). This is typically a faulty GPU-offload path. Remedy: pin the model to CPU —\n    printf 'FROM ${modelId}\\nPARAMETER num_gpu 0\\n' | ollama create ${modelId.replace(/[:/]/g, '-')}-cpu -f -\n  then bench the -cpu variant, or fix the GPU driver/backend.`
        : `  DIAGNOSIS: the model responds natively (${JSON.stringify(native.slice(0, 40))}) but fails the governed wire shape — likely a structured-output or budget incompatibility; re-run with GOVERNANCE_LLM_REASONING_EFFORT=none or off.`,
    );
  }
  return allPass;
}

async function main(): Promise<void> {
  let models = MODELS;
  if (models.length === 0) {
    const response = await fetch(`${ORIGIN}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    const data = (await response.json()) as { models?: { name: string; digest?: string }[] };
    // Dedupe alias tags of the same weights (e.g. gpt-oss:latest ≡ gpt-oss:20b).
    const seen = new Set<string>();
    models = (data.models ?? [])
      .filter((m) => {
        const key = m.digest ?? m.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((m) => m.name);
    if (models.length === 0) throw new Error(`no models installed at ${ORIGIN}`);
  }
  log(`bench:llm — ${models.length} model(s) via ${BASE_URL} (${WARM_RUNS} warm run(s)/surface)`);
  const failures: string[] = [];
  for (const model of models) {
    try {
      if (!(await benchModel(model))) failures.push(model);
    } catch (error) {
      log(`  FAILED to bench: ${error instanceof Error ? error.message : String(error)}`);
      failures.push(model);
    }
  }
  log(
    failures.length === 0
      ? `\nALL PASS — every model served every governed surface.`
      : `\nFAILURES: ${failures.join(', ')}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
