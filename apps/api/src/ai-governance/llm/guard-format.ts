// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Moderation-lane OUTPUT-FORMAT profiles (WS-U ADR-9, the role-split revision).
// The moderation lane's project-wide default model is a GUARD-family generative
// safety classifier (Qwen3Guard-Gen): it is trained to emit a fixed
// `Safety:/Categories:/Refusal:` block via its own chat template, NOT to follow
// arbitrary JSON-schema response formats — forcing guided decoding onto it
// degrades exactly the classification quality it was selected for. So the
// proposer speaks each model family's native dialect:
//
//   'json'       — the generalist profile: strict JSON `{action, reason}` via
//                  the schema-constrained response_format (the original path).
//   'qwen3guard' — the guard profile: the conversation alone is sent (no
//                  system prompt, no response_format — the model's template
//                  owns the framing), the emitted Safety/Categories block is
//                  parsed TOLERANTLY, and a DETERMINISTIC, versioned mapping
//                  converts the guard taxonomy onto the moderation action
//                  vocabulary. An unparseable output is `invalid_output`
//                  (⇒ unavailable ⇒ baseline + deferred re-moderation) — the
//                  model never freetexts an action into effect.
//
// The guard profile enforces the model's FIXED safety taxonomy: the room's
// ratified moderation prompt does not condition it (guard templates classify
// every turn they are handed — injecting policy prose would be classified as
// content). A room that wants prompt-conditioned moderation selects a
// generalist moderation-lane model through the hub-candidacy path instead;
// the deterministic wrapper (ceiling + capability clamp) bounds both profiles
// identically. The mapping below is config-hashed into the registry identity
// (GUARD_FORMAT_VERSION), so changing it re-clears the WS-K gate.

import type { ModerationAction } from '@licio/governance';

/** The moderation-lane completion dialects. */
export type ModerationOutputFormat = 'json' | 'qwen3guard';

/** Bumped whenever the guard prompt framing, parser, or taxonomy mapping
 *  changes (pinned via the identity config into every AIOutputRecord hash). */
export const GUARD_FORMAT_VERSION = 1;

/** Guard-family model ids (case-insensitive substring): the Qwen3Guard line —
 *  `Qwen/Qwen3Guard-Gen-4B`, an `hf.co/...Qwen3Guard...GGUF` Ollama pull, a
 *  room-selected `Qwen/Qwen3Guard-Gen-8B`, all detected. */
const GUARD_MODEL_ID_PATTERN = /qwen3guard/i;

/**
 * Resolve the output format for a moderation model id. `override` is the
 * operator's GOVERNANCE_LLM_MODERATION_FORMAT ('auto' and undefined both
 * auto-detect); hub-selected room models always auto-detect.
 */
export function resolveModerationOutputFormat(
  modelId: string,
  override?: 'auto' | 'json' | 'guard' | undefined,
): ModerationOutputFormat {
  if (override === 'json') return 'json';
  if (override === 'guard') return 'qwen3guard';
  return GUARD_MODEL_ID_PATTERN.test(modelId) ? 'qwen3guard' : 'json';
}

/** The parsed guard block (the model's fixed taxonomy verdict). */
export interface GuardVerdict {
  safety: 'safe' | 'controversial' | 'unsafe';
  categories: string[];
}

const GUARD_SAFETY_VALUES = new Set(['safe', 'controversial', 'unsafe']);
/** Bounds on the parsed category list (defence-in-depth on model output). */
const GUARD_MAX_CATEGORIES = 10;
const GUARD_MAX_CATEGORY_CHARS = 64;

/**
 * TOLERANT parser for the Qwen3Guard-Gen output block:
 *
 *   Safety: Unsafe
 *   Categories: Violent, Jailbreak
 *
 * Line order, casing, surrounding prose/whitespace, and a missing Categories
 * line (⇒ []) are all tolerated; a missing/unrecognized Safety verdict returns
 * null (the caller treats it as `invalid_output` ⇒ baseline + deferred
 * re-moderation). "None" categories collapse to []. No regex over model output
 * (ReDoS posture): plain line scanning.
 *
 * INJECTION AMBIGUITY IS FAIL-CLOSED: a guard model never emits two verdicts,
 * so if the output carries CONFLICTING recognized `Safety:` values — the only
 * way that happens is a broken/echoing model replaying attacker content that
 * itself contains a `Safety:` line — the parse is null rather than letting
 * either line win. (Repeated lines with the SAME value are tolerated: an echo
 * that merely agrees decides nothing.) The residual single-line spoof — a
 * model that echoes ONLY the injected line and never states its own verdict —
 * is indistinguishable from a real verdict by construction and is caught as a
 * broken pairing by `pnpm bench:llm`, with the WS-J platform baseline
 * moderating independently underneath either way.
 */
export function parseGuardVerdict(text: string): GuardVerdict | null {
  let safety: GuardVerdict['safety'] | null = null;
  let categories: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const label = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (label === 'safety') {
      const candidate = value.toLowerCase();
      if (!GUARD_SAFETY_VALUES.has(candidate)) continue;
      if (safety !== null && safety !== candidate) return null; // conflicting verdicts
      safety = candidate as GuardVerdict['safety'];
    } else if (label === 'categories' && categories.length === 0) {
      categories = value
        .split(',')
        .map((entry) => entry.trim().slice(0, GUARD_MAX_CATEGORY_CHARS))
        .filter((entry) => entry.length > 0 && entry.toLowerCase() !== 'none')
        .slice(0, GUARD_MAX_CATEGORIES);
    }
  }
  if (safety === null) return null;
  return { safety, categories };
}

/**
 * The DETERMINISTIC guard-taxonomy → moderation-action mapping (versioned via
 * GUARD_FORMAT_VERSION). Safe passes; Controversial warns (visible, a note to
 * the author); Unsafe escalates to human review — the wrapper's
 * escalate-to-review ceiling means a guard model can never exceed
 * `flag_for_review` regardless, and the community-capability clamp still
 * applies below it.
 */
export function mapGuardVerdictToModeration(verdict: GuardVerdict): {
  action: ModerationAction;
  reason: string;
} {
  const categories = verdict.categories.length > 0 ? ` (${verdict.categories.join(', ')})` : '';
  if (verdict.safety === 'safe') {
    return { action: 'allow', reason: 'Guard classification: safe.' };
  }
  if (verdict.safety === 'controversial') {
    return {
      action: 'warn',
      reason: `Guard classification: controversial${categories}.`.slice(0, 280),
    };
  }
  return {
    action: 'flag_for_review',
    reason: `Guard classification: unsafe${categories}.`.slice(0, 280),
  };
}
