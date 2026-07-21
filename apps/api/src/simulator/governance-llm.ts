// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DEV-ONLY simulated local governance-LLM runtime (NEVER in production). A
// zero-dependency node:http server, bound to the loopback interface only, that
// speaks the same OpenAI-compatible protocol as the real `local` runtimes
// (vLLM, Ollama, llama.cpp server, LM Studio): POST /chat/completions for all
// three governed surfaces — including the schema-less GUARD dialect (a bare
// user turn answered with the native Safety:/Categories: block), so
// guard-family hub candidacy works in dev — plus GET /v1/models (the standard
// listing the runtime catalog probes; seeing the sim id there activates the
// catalog's dev wildcard). The boot wiring points the UNCHANGED WS-U ADR-9
// `local` backend seam (`ai-governance/llm/local.ts`) at it and the ENTIRE
// governed LLM path runs on a bare `pnpm dev` box: WS-K registration +
// admission + the deploy gate, the pre-execution guard, the strict output
// schemas, the §24.5 summary quality gate, per-room budgets + the circuit
// breaker, immutable AIOutputRecords, the deterministic moderation wrapper
// (escalate-to-review ceiling + capability clamp), and deferred re-moderation.
// Nothing here shortcuts that machinery: this module only ANSWERS the
// protocol; every guarantee stays enforced by the real path on the client side.
//
// The "model" is a deterministic template classifier/summariser (no weights, no
// randomness, no clock), so dev behaviour is reproducible and the k-of-N
// admission sampling passes deterministically. Failure-injection markers in the
// governed text let a developer exercise every fail-closed branch on demand:
//   [sim:error]            → HTTP 500                (⇒ transport failure)
//   [sim:refuse]           → finish_reason=content_filter (⇒ refusal)
//   [sim:truncate]         → finish_reason=length    (⇒ truncated)
//   [sim:garbage]          → non-JSON prose          (⇒ invalid_output)
//   [sim:propose=<action>] → forces a moderation verdict (e.g. remove — shows
//                            the wrapper clamping it to flag_for_review)
//   [sim:ungrounded]       → off-proposal summary    (⇒ quality-gate rejection)
//   [sim:foreign-url]      → off-proposal URL        (⇒ url_not_in_proposal)
//   [sim:debate=<class>]   → forces the debate class (incumbent/challenger/
//                            inconclusive)
//   [sim:rationale-url]    → URL in the debate rationale (⇒ the deterministic
//                            shell rejects it and falls back to the MLP)
// Room content is classified/summarised, never logged (the house rule; the
// optional log hook carries metadata only).

import { createServer, type Server } from 'node:http';
import { MODERATION_ACTIONS, type ModerationAction } from '@licio/governance';
import { z } from 'zod';
import { SIMULATED_GOVERNANCE_LLM_MODEL_ID } from '../ai-governance/llm/config.js';

/** The model name the simulated runtime serves (the boot wiring passes it as
 *  GOVERNANCE_LLM_MODEL, so the registry identity names the simulator openly).
 *  DEFINED in llm/config.ts — the runtime catalog's dev wildcard needs it
 *  without importing simulator code — and re-exported here for the dev boot's
 *  dynamic import. */
export { SIMULATED_GOVERNANCE_LLM_MODEL_ID };

/** Fixed default port so the config-hashed registry identity (which folds in
 *  the loopback base URL) stays STABLE across dev reboots — a persistent dev
 *  registry then re-uses one deployed identity instead of minting one per boot.
 *  Falls back to an ephemeral port when taken. */
export const SIMULATED_GOVERNANCE_LLM_DEFAULT_PORT = 3117;

/** The minimal OpenAI-compatible request surface consumed here (zod at the
 *  boundary, unknown fields stripped — the same discipline as local.ts). */
const chatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
  response_format: z
    .object({
      type: z.string(),
      json_schema: z.object({ schema: z.record(z.string(), z.unknown()) }),
    })
    .optional(),
});

// --- deterministic text utilities (ReDoS-free: no regex over governed text) --

function collapseWhitespace(text: string): string {
  const parts: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (cur.length > 0) {
        parts.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts.join(' ');
}

/** Truncate at a word boundary WITHOUT adding an ellipsis, so every token in
 *  the output still appears verbatim in the input (the summary stays fully
 *  grounded under the §24.5 gate's token check). */
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

// --- failure-injection markers ----------------------------------------------

function hasMarker(text: string, name: string): boolean {
  return text.includes(`[sim:${name}]`);
}

/** `[sim:propose=<action>]` forces the moderation verdict (dev testing of the
 *  wrapper's ceiling/clamp); an unknown action name is ignored. */
export function forcedModerationAction(text: string): ModerationAction | null {
  const tag = '[sim:propose=';
  const start = text.indexOf(tag);
  if (start === -1) return null;
  const end = text.indexOf(']', start + tag.length);
  if (end === -1) return null;
  const candidate = text.slice(start + tag.length, end);
  return (MODERATION_ACTIONS as readonly string[]).includes(candidate)
    ? (candidate as ModerationAction)
    : null;
}

// --- the moderation surface ---------------------------------------------------

/** The parsed `<contribution>` block of the moderation user prompt
 *  (`ai-governance/llm/moderation.ts` buildUserPrompt). Missing fields default
 *  benign — a malformed prompt degrades toward `allow`, never a restriction. */
export interface SimulatedContribution {
  linkCount: number;
  authorAccountAgeDays: number;
  authorNewToRoom: boolean;
  priorRemovalsInRoom: number;
  text: string;
}

export function parseContribution(userPrompt: string): SimulatedContribution {
  const parsed: SimulatedContribution = {
    linkCount: 0,
    authorAccountAgeDays: 365,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
    text: '',
  };
  let inBlock = false;
  let inText = false;
  const textLines: string[] = [];
  for (const line of userPrompt.split('\n')) {
    if (line === '<contribution>') {
      inBlock = true;
      continue;
    }
    if (line === '</contribution>') break;
    if (!inBlock) continue;
    if (inText) {
      textLines.push(line);
      continue;
    }
    if (line === 'text:') {
      inText = true;
      continue;
    }
    const sep = line.indexOf(': ');
    if (sep === -1) continue;
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);
    if (key === 'links') parsed.linkCount = Number.parseInt(value, 10) || 0;
    else if (key === 'author_account_age_days') {
      parsed.authorAccountAgeDays = Number.parseInt(value, 10) || 0;
    } else if (key === 'author_new_to_room') parsed.authorNewToRoom = value === 'true';
    else if (key === 'prior_removals_in_room') {
      parsed.priorRemovalsInRoom = Number.parseInt(value, 10) || 0;
    }
  }
  parsed.text = textLines.join('\n');
  return parsed;
}

/** Distinct-hit spam vocabulary (two or more distinct terms reads as spam). */
const SPAM_TERMS = [
  'buy',
  'cheap',
  'pills',
  'casino',
  'giveaway',
  'promo code',
  'discount',
  'free money',
  'click',
] as const;

/** Hostile-wording vocabulary (routes to human review, never auto-removes). */
const HOSTILE_TERMS = ['idiot', 'stupid', 'moron', 'worthless', 'shut up', 'hate you'] as const;

/**
 * The simulated model's fixed classification ladder. It deliberately spans the
 * FULL action vocabulary — including `remove`, which the deterministic wrapper
 * then clamps to `flag_for_review` (the escalate-to-human-review ceiling), so a
 * dev box demonstrates the bounding, not just benign flows. It also clears the
 * platform admission eval set (`PLATFORM_EVAL_SET`) deterministically: benign
 * text → `allow`; link-spam → `remove`/`flag_for_review` (both in band).
 */
export function classifySimulatedModeration(contribution: SimulatedContribution): {
  action: ModerationAction;
  reason: string;
} {
  const lower = contribution.text.toLowerCase();
  const spamHits = SPAM_TERMS.filter((term) => lower.includes(term)).length;
  if (spamHits >= 2 && contribution.linkCount >= 1) {
    return {
      action: 'remove',
      reason: 'Commercial spam with links — proposed for removal (a human confirms first).',
    };
  }
  if (spamHits >= 2) {
    return { action: 'flag_for_review', reason: 'Spam-like wording — routed to human review.' };
  }
  if (HOSTILE_TERMS.some((term) => lower.includes(term))) {
    return { action: 'flag_for_review', reason: 'Hostile wording — routed to human review.' };
  }
  if (contribution.linkCount >= 3) {
    return { action: 'flag_for_review', reason: 'High link density — routed to human review.' };
  }
  if (contribution.priorRemovalsInRoom >= 2) {
    return {
      action: 'flag_for_review',
      reason: 'Author has prior removals in this room — routed to human review.',
    };
  }
  if (contribution.authorNewToRoom && contribution.linkCount >= 1) {
    return {
      action: 'flag_for_review',
      reason: 'New author posting a link — routed to human review.',
    };
  }
  if (contribution.authorAccountAgeDays < 7 && contribution.linkCount >= 1) {
    return { action: 'warn', reason: 'Young account posting a link.' };
  }
  return { action: 'allow', reason: 'Civil, on-topic contribution — no action.' };
}

// --- the lawmaking-summary surface -------------------------------------------

/** The parsed `<proposal>` block of the summary user prompt
 *  (`ai-governance/llm/provider.ts` buildUserPrompt). */
export interface SimulatedProposal {
  title: string;
  body: string;
  options: string[];
}

export function parseProposal(userPrompt: string): SimulatedProposal {
  const parsed: SimulatedProposal = { title: '', body: '', options: [] };
  let inBlock = false;
  let mode: 'fields' | 'body' | 'options' = 'fields';
  const bodyLines: string[] = [];
  for (const line of userPrompt.split('\n')) {
    if (line === '<proposal>') {
      inBlock = true;
      continue;
    }
    if (line === '</proposal>') break;
    if (!inBlock) continue;
    if (line.startsWith('Options (') && line.endsWith('):')) {
      mode = 'options';
      continue;
    }
    if (mode === 'options') {
      if (line === '(none)') continue;
      // "1. Adopt" → "Adopt" (tolerate any numbering width; no regex).
      const dot = line.indexOf('. ');
      parsed.options.push(dot > 0 ? line.slice(dot + 2) : line);
      continue;
    }
    if (mode === 'fields' && line.startsWith('Title: ')) {
      parsed.title = line.slice('Title: '.length);
      continue;
    }
    if (mode === 'fields' && line === 'Body:') {
      mode = 'body';
      continue;
    }
    if (mode === 'body') bodyLines.push(line);
  }
  parsed.body = bodyLines.join('\n');
  return parsed;
}

/**
 * The simulated model's extractive summary: every content token comes verbatim
 * from the proposal (word-boundary truncation, no ellipsis), so a compliant
 * draft clears the §24.5 grounding + URL gates by construction — exactly the
 * behaviour the real system prompt instructs of a compliant model.
 */
export function draftSimulatedSummary(proposal: SimulatedProposal): {
  headline: string;
  summary: string;
} {
  const title = collapseWhitespace(proposal.title);
  const body = collapseWhitespace(proposal.body);
  const headline = truncateAtWord(title.length > 0 ? title : body, 120) || 'Proposal';
  const optionsPart =
    proposal.options.length > 0
      ? `Options: ${proposal.options.map(collapseWhitespace).join('; ')}`
      : '';
  const summary =
    truncateAtWord([truncateAtWord(body, 400), optionsPart].filter(Boolean).join(' '), 590) ||
    headline;
  return { headline, summary };
}

// --- the debate-adjudication surface ------------------------------------------

/** One parsed side of the `<debate>` block (`ai-governance/llm/debate.ts`
 *  buildDebateUserPrompt). */
export interface SimulatedDebateSide {
  sourceCount: number;
  safeSourceCount: number;
  rebuts: boolean;
  summaryTokens: number;
}

function countTokens(text: string): number {
  let count = 0;
  let inWord = false;
  for (const ch of text) {
    const ws =
      ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
    if (ws) inWord = false;
    else if (!inWord) {
      count += 1;
      inWord = true;
    }
  }
  return count;
}

export function parseDebate(userPrompt: string): {
  incumbent: SimulatedDebateSide;
  challenger: SimulatedDebateSide;
} {
  const emptySide = (): SimulatedDebateSide => ({
    sourceCount: 0,
    safeSourceCount: 0,
    rebuts: false,
    summaryTokens: 0,
  });
  const sides = { incumbent: emptySide(), challenger: emptySide() };
  let current: SimulatedDebateSide | null = null;
  let inSummary = false;
  let summaryLines: string[] = [];
  const closeSide = () => {
    if (current) current.summaryTokens = countTokens(summaryLines.join('\n'));
    summaryLines = [];
    inSummary = false;
  };
  for (const line of userPrompt.split('\n')) {
    if (line === '<position side="incumbent">') {
      closeSide();
      current = sides.incumbent;
      continue;
    }
    if (line === '<position side="challenger">') {
      closeSide();
      current = sides.challenger;
      continue;
    }
    if (line === '</position>') {
      closeSide();
      current = null;
      continue;
    }
    if (!current) continue;
    if (inSummary) {
      summaryLines.push(line);
      continue;
    }
    if (line === 'summary:') {
      inSummary = true;
      continue;
    }
    if (line.startsWith('rebuts_opponent: ')) {
      current.rebuts = line.endsWith('true');
      continue;
    }
    if (line.startsWith('- url: ')) {
      current.sourceCount += 1;
      if (line.includes('link_safe: true')) current.safeSourceCount += 1;
    }
  }
  closeSide();
  return sides;
}

/** `[sim:debate=<class>]` forces the winning class; unknown names are ignored. */
export function forcedDebateClass(
  text: string,
): 'incumbent' | 'challenger' | 'inconclusive' | null {
  const tag = '[sim:debate=';
  const start = text.indexOf(tag);
  if (start === -1) return null;
  const end = text.indexOf(']', start + tag.length);
  if (end === -1) return null;
  const candidate = text.slice(start + tag.length, end);
  return candidate === 'incumbent' || candidate === 'challenger' || candidate === 'inconclusive'
    ? candidate
    : null;
}

/**
 * The simulated adjudicator: a fixed sourcing-quality rubric per side (source
 * count, safe-source rate, direct rebuttal, argument substance), a near-tie ⇒
 * inconclusive rule, and a confidence that grows with the lead. Probabilities
 * only — the REAL deterministic shell (`ai-governance/llm/debate.ts`) maps
 * them to the outcome, exactly as with a live model.
 */
export function assessSimulatedDebate(sides: {
  incumbent: SimulatedDebateSide;
  challenger: SimulatedDebateSide;
}): {
  probabilities: { incumbent: number; challenger: number; inconclusive: number };
  rationale: string;
} {
  const score = (s: SimulatedDebateSide): number => {
    const sourceScore = Math.min(s.sourceCount / 5, 1);
    const safeRate = s.sourceCount > 0 ? s.safeSourceCount / s.sourceCount : 0;
    const substance = Math.min(s.summaryTokens / 200, 1);
    return 0.45 * sourceScore + 0.2 * safeRate + 0.15 * (s.rebuts ? 1 : 0) + 0.2 * substance;
  };
  const zI = score(sides.incumbent);
  const zC = score(sides.challenger);
  const lead = zC - zI;
  if (Math.abs(lead) < 0.08) {
    return {
      probabilities: { incumbent: 0.15, challenger: 0.15, inconclusive: 0.7 },
      rationale:
        'Both positions are comparably sourced and substantiated; neither side clearly prevails.',
    };
  }
  const winnerP = Math.min(0.9, 0.55 + Math.abs(lead));
  const loserP = Math.max(0, 1 - winnerP - 0.08);
  const winnerIsChallenger = lead > 0;
  return {
    probabilities: {
      incumbent: winnerIsChallenger ? loserP : winnerP,
      challenger: winnerIsChallenger ? winnerP : loserP,
      inconclusive: 0.08,
    },
    rationale: winnerIsChallenger
      ? `The challenger presented the stronger sourced case (${sides.challenger.sourceCount} sources vs ${sides.incumbent.sourceCount}).`
      : `The incumbent presented the stronger sourced case (${sides.incumbent.sourceCount} sources vs ${sides.challenger.sourceCount}).`,
  };
}

// --- the protocol core (pure request → response; the http layer is a shell) --

export interface SimulatedChatResponse {
  status: number;
  body: Record<string, unknown>;
}

function completion(
  model: string,
  content: string | null,
  finishReason: string,
): SimulatedChatResponse {
  return {
    status: 200,
    body: {
      id: 'sim-cmpl',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    },
  };
}

function badRequest(message: string): SimulatedChatResponse {
  return { status: 400, body: { error: { message } } };
}

/** Answer one chat-completion request deterministically (no clock, no RNG). */
export function simulateChatCompletion(payload: unknown): SimulatedChatResponse {
  const parsed = chatCompletionRequestSchema.safeParse(payload);
  if (!parsed.success) return badRequest('malformed chat.completions request');
  const request = parsed.data;
  const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  // Failure injection (markers live in the governed text itself).
  if (hasMarker(user, 'error')) {
    return { status: 500, body: { error: { message: 'simulated inference failure' } } };
  }
  if (hasMarker(user, 'refuse')) return completion(request.model, null, 'content_filter');
  if (hasMarker(user, 'truncate')) return completion(request.model, '{"acti', 'length');
  if (hasMarker(user, 'garbage')) {
    return completion(request.model, 'This contribution seems fine to me.', 'stop');
  }

  // The GUARD dialect (the moderation lane's Qwen3Guard-family profile): NO
  // response_format and no system turn — the request is the bare contribution
  // text, and the reply is the native `Safety:/Categories:` block. Without
  // this branch, a guard-family hub selection in `pnpm dev` (which the
  // catalog's wildcard resolves to this simulator) would 400 forever and the
  // candidacy flow the wildcard exists for would be dead for exactly the
  // project's flagship moderation family. The ladder reuses
  // `classifySimulatedModeration` so both dialects classify identically.
  if (request.response_format === undefined) {
    const forced = forcedModerationAction(user);
    const action =
      forced ??
      classifySimulatedModeration({
        text: user,
        // The guard dialect carries no context framing — derive the link
        // count from the text itself (deterministic; mirrors what a guard
        // model "sees") and neutralize the author-history heuristics.
        linkCount: user.split('http').length - 1,
        authorAccountAgeDays: 365,
        authorNewToRoom: false,
        priorRemovalsInRoom: 0,
      }).action;
    const block =
      action === 'allow'
        ? 'Safety: Safe\nCategories: None'
        : action === 'warn'
          ? 'Safety: Controversial\nCategories: Unethical Acts'
          : 'Safety: Unsafe\nCategories: Violent';
    return completion(request.model, block, 'stop');
  }

  // Surface detection: the response_format schema names the governed surface
  // (the moderation verdict has `action`; the lawmaking summary has `headline`).
  const properties = request.response_format?.json_schema.schema['properties'];
  const keys = properties !== null && typeof properties === 'object' ? properties : {};
  if ('action' in keys) {
    const forced = forcedModerationAction(user);
    const verdict = forced
      ? { action: forced, reason: `Simulator-forced ${forced}.` }
      : classifySimulatedModeration(parseContribution(user));
    return completion(request.model, JSON.stringify(verdict), 'stop');
  }
  if ('headline' in keys) {
    if (hasMarker(user, 'ungrounded')) {
      return completion(
        request.model,
        JSON.stringify({
          headline: 'Quantum llamas reconsidered',
          summary:
            'Deliberately ungrounded simulator prose about orbital mechanics, sourdough hydration and quantum llamas.',
        }),
        'stop',
      );
    }
    const draft = draftSimulatedSummary(parseProposal(user));
    if (hasMarker(user, 'foreign-url')) {
      return completion(
        request.model,
        JSON.stringify({
          ...draft,
          summary: `${draft.summary} See https://not-in-the-proposal.example/details`,
        }),
        'stop',
      );
    }
    return completion(request.model, JSON.stringify(draft), 'stop');
  }
  if ('probabilities' in keys) {
    const forced = forcedDebateClass(user);
    const assessment = forced
      ? {
          probabilities: {
            incumbent: forced === 'incumbent' ? 0.8 : 0.1,
            challenger: forced === 'challenger' ? 0.8 : 0.1,
            inconclusive: forced === 'inconclusive' ? 0.8 : 0.1,
          },
          rationale: `Simulator-forced ${forced} outcome.`,
        }
      : assessSimulatedDebate(parseDebate(user));
    if (hasMarker(user, 'rationale-url')) {
      assessment.rationale = `${assessment.rationale} See https://exfil.example/proof`;
    }
    return completion(request.model, JSON.stringify(assessment), 'stop');
  }
  return badRequest('unrecognised response_format for the simulated governance runtime');
}

// --- the loopback http shell --------------------------------------------------

const MAX_BODY_BYTES = 1_048_576; // far above any governed prompt; bounds a runaway client

export interface SimulatedGovernanceLlmOptions {
  /** Preferred port (default SIMULATED_GOVERNANCE_LLM_DEFAULT_PORT); falls back
   *  to an ephemeral port when taken. */
  port?: number;
  /** Metadata-only observability hook (never receives governed content). */
  log?: (event: string, meta: Record<string, unknown>) => void;
}

export interface SimulatedGovernanceLlmHandle {
  /** The loopback base URL for GOVERNANCE_LLM_LOCAL_URL (…/v1). */
  baseUrl: string;
  port: number;
  close(): Promise<void>;
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('simulated governance LLM runtime bound no TCP address'));
        return;
      }
      resolvePort(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start the simulated runtime on the loopback interface. DEV ONLY: refuses to
 * start in production (defense-in-depth on top of the boot wiring's NODE_ENV
 * gate), and binds 127.0.0.1 explicitly so it is never reachable off-host.
 */
export async function startSimulatedGovernanceLlm(
  options: SimulatedGovernanceLlmOptions = {},
): Promise<SimulatedGovernanceLlmHandle> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('the simulated governance LLM runtime must never start in production');
  }
  const log = options.log ?? (() => {});
  const server = createServer((req, res) => {
    const respond = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // The standard OpenAI-compatible model listing (what `GET /v1/models`
    // answers on vLLM/Ollama too): the runtime catalog probes it — seeing the
    // sim id here is what activates the catalog's DEV wildcard, so the full
    // hub-candidacy flow is exercisable under `pnpm dev` with zero setup.
    if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
      respond(200, {
        object: 'list',
        data: [{ id: SIMULATED_GOVERNANCE_LLM_MODEL_ID, object: 'model' }],
      });
      return;
    }
    if (req.method !== 'POST') {
      respond(405, { error: { message: 'method not allowed' } });
      return;
    }
    if (!(req.url ?? '').endsWith('/chat/completions')) {
      respond(404, { error: { message: 'not found' } });
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        aborted = true;
        respond(413, { error: { message: 'request body too large' } });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        respond(400, { error: { message: 'request body is not JSON' } });
        return;
      }
      const result = simulateChatCompletion(payload);
      log('sim.llm.completion', { status: result.status });
      respond(result.status, result.body);
    });
    req.on('error', () => {
      /* client went away; nothing to answer */
    });
  });

  const desired = options.port ?? SIMULATED_GOVERNANCE_LLM_DEFAULT_PORT;
  let port: number;
  try {
    port = await listenOn(server, desired);
  } catch {
    // The fixed default is taken (a second dev process, or an unrelated
    // service): fall back to an ephemeral port — the boot log states the URL.
    port = await listenOn(server, 0);
  }
  log('sim.llm.started', { port });
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}
