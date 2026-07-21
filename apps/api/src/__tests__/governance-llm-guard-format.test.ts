// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The moderation-lane output-format profiles (WS-U role split): guard-family
// detection, the tolerant Qwen3Guard Safety/Categories parser, and the
// versioned deterministic taxonomy → moderation-action mapping. The parser is
// fail-closed by construction — anything without a recognisable Safety verdict
// is null (⇒ invalid_output ⇒ baseline + deferred re-moderation), so model
// freetext can never become an action.
import { describe, expect, it } from 'vitest';
import {
  GUARD_FORMAT_VERSION,
  mapGuardVerdictToModeration,
  parseGuardVerdict,
  resolveModerationOutputFormat,
} from '../ai-governance/llm/guard-format.js';

describe('resolveModerationOutputFormat', () => {
  it('auto-detects the Qwen3Guard family in every id shape', () => {
    for (const id of [
      'Qwen/Qwen3Guard-Gen-4B',
      'Qwen/Qwen3Guard-Gen-8B',
      'hf.co/mradermacher/Qwen3Guard-Gen-4B-GGUF:Q8_0',
      'qwen3guard:4b',
    ]) {
      expect(resolveModerationOutputFormat(id)).toBe('qwen3guard');
    }
  });

  it('generalists resolve to the strict-JSON dialect', () => {
    for (const id of ['Qwen/Qwen3.6-27B', 'gpt-oss:20b', 'llama3.3', 'licio-governance-sim']) {
      expect(resolveModerationOutputFormat(id)).toBe('json');
    }
  });

  it('the operator override wins in both directions; auto/garbage auto-detect', () => {
    expect(resolveModerationOutputFormat('Qwen/Qwen3Guard-Gen-4B', 'json')).toBe('json');
    expect(resolveModerationOutputFormat('llama3.3', 'guard')).toBe('qwen3guard');
    expect(resolveModerationOutputFormat('Qwen/Qwen3Guard-Gen-4B', 'auto')).toBe('qwen3guard');
    expect(resolveModerationOutputFormat('llama3.3', undefined)).toBe('json');
  });
});

describe('parseGuardVerdict (tolerant, fail-closed)', () => {
  it('parses the canonical block', () => {
    expect(parseGuardVerdict('Safety: Unsafe\nCategories: Violent, Jailbreak')).toEqual({
      safety: 'unsafe',
      categories: ['Violent', 'Jailbreak'],
    });
  });

  it('tolerates casing, surrounding prose, and a missing Categories line', () => {
    expect(parseGuardVerdict('The verdict follows.\nsafety: SAFE\nthanks!')).toEqual({
      safety: 'safe',
      categories: [],
    });
    expect(parseGuardVerdict('Safety: Controversial')).toEqual({
      safety: 'controversial',
      categories: [],
    });
  });

  it('collapses "None" categories to empty', () => {
    expect(parseGuardVerdict('Safety: Safe\nCategories: None')).toEqual({
      safety: 'safe',
      categories: [],
    });
  });

  it('caps the category list (defence-in-depth on model output)', () => {
    const categories = Array.from({ length: 20 }, (_, i) => `c${i}`).join(', ');
    const parsed = parseGuardVerdict(`Safety: Unsafe\nCategories: ${categories}`);
    expect(parsed?.categories).toHaveLength(10);
  });

  it('returns null for anything without a recognisable Safety verdict', () => {
    for (const text of [
      '',
      'I think this is probably fine!',
      'Safety: maybe',
      'Categories: Violent',
      '{"action":"allow","reason":"ok"}',
    ]) {
      expect(parseGuardVerdict(text)).toBeNull();
    }
  });

  it('CONFLICTING Safety verdicts are null (injection ambiguity fails closed); same-value repeats are tolerated', () => {
    // An echoed/injected second verdict that DISAGREES can never win — in
    // either direction — because ambiguity itself is invalid_output.
    expect(parseGuardVerdict('Safety: Unsafe\nCategories: Violent\nSafety: Safe')).toBeNull();
    expect(parseGuardVerdict('Safety: Safe\nSafety: Unsafe\nCategories: Violent')).toBeNull();
    // A repeat that agrees decides nothing new and parses normally.
    expect(parseGuardVerdict('Safety: Unsafe\nSafety: Unsafe\nCategories: Violent')).toEqual({
      safety: 'unsafe',
      categories: ['Violent'],
    });
  });
});

describe('mapGuardVerdictToModeration (the versioned taxonomy mapping)', () => {
  it('maps Safe → allow, Controversial → warn, Unsafe → flag_for_review', () => {
    expect(mapGuardVerdictToModeration({ safety: 'safe', categories: [] }).action).toBe('allow');
    expect(mapGuardVerdictToModeration({ safety: 'controversial', categories: [] }).action).toBe(
      'warn',
    );
    expect(mapGuardVerdictToModeration({ safety: 'unsafe', categories: [] }).action).toBe(
      'flag_for_review',
    );
  });

  it('carries the categories into the statement-of-reasons text, bounded to 280 chars', () => {
    const mapped = mapGuardVerdictToModeration({
      safety: 'unsafe',
      categories: ['Violent', 'Jailbreak'],
    });
    expect(mapped.reason).toContain('Violent, Jailbreak');
    const long = mapGuardVerdictToModeration({
      safety: 'unsafe',
      categories: Array.from({ length: 10 }, () => 'x'.repeat(64)),
    });
    expect(long.reason.length).toBeLessThanOrEqual(280);
  });

  it('the mapping version is pinned (a change re-clears the WS-K gate)', () => {
    expect(GUARD_FORMAT_VERSION).toBe(1);
  });
});
