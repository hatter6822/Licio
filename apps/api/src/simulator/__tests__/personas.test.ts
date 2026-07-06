// SPDX-License-Identifier: AGPL-3.0-or-later
import { HANDLE_PATTERN } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  archetypeOf,
  BASE_ROSTER,
  CLUSTER_ROSTER,
  lensVantageOf,
  NEWCOMER_CAP,
  newcomerSpec,
  PERSONA_ARCHETYPES,
  SIM_LENS_NAMES,
  SIM_LENS_TYPES,
  SIM_USER_ID,
} from '../personas.js';
import { req } from './sim-test-util.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('simulator personas', () => {
  it('every roster user has a valid handle and a v4-shaped id', () => {
    const all = [...BASE_ROSTER, ...CLUSTER_ROSTER];
    for (const persona of all) {
      expect(persona.handle).toMatch(HANDLE_PATTERN);
      expect(persona.userId).toMatch(UUID_RE);
      expect(persona.displayName.length).toBeGreaterThan(0);
      expect(persona.displayName.length).toBeLessThanOrEqual(80);
    }
  });

  it('user ids are unique across the whole roster', () => {
    const ids = [...BASE_ROSTER, ...CLUSTER_ROSTER].map((p) => p.userId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cluster accounts are the fresh (age 0) adversarial archetype', () => {
    for (const spec of CLUSTER_ROSTER) {
      expect(spec.archetype).toBe('cluster_member');
      expect(archetypeOf(spec).accountAgeDays).toBe(0);
    }
  });

  it('organic authors are backdated so they read as aged accounts', () => {
    const author = BASE_ROSTER.find((p) => p.archetype === 'author');
    expect(author).toBeDefined();
    expect(archetypeOf(req(author)).accountAgeDays).toBeGreaterThanOrEqual(30);
  });

  it('newcomer specs are unique and handle-valid up to the cap', () => {
    const ids = new Set<string>();
    const handles = new Set<string>();
    for (let i = 0; i < NEWCOMER_CAP; i += 1) {
      const spec = newcomerSpec(i);
      expect(spec.handle).toMatch(HANDLE_PATTERN);
      expect(spec.userId).toMatch(UUID_RE);
      ids.add(spec.userId);
      handles.add(spec.handle);
    }
    expect(ids.size).toBe(NEWCOMER_CAP);
    expect(handles.size).toBe(NEWCOMER_CAP);
  });

  it('SIM_USER_ID never collides with the demo-seed id family', () => {
    // Demo seed uses 5f5e0000..5f5ec000; the simulator uses 5f5ed000.
    expect(SIM_USER_ID(1)).toMatch(/^5f5ed000-/);
    expect(SIM_USER_ID(1)).not.toBe('5f5e0000-0000-4000-8000-000000000001');
  });

  it('every archetype has coherent weighting lists', () => {
    for (const archetype of Object.values(PERSONA_ARCHETYPES)) {
      for (const list of [archetype.dwell, archetype.replyDepth, archetype.returns]) {
        expect(list.length).toBeGreaterThan(0);
        for (const entry of list) expect(entry.weight).toBeGreaterThanOrEqual(0);
        expect(list.some((e) => e.weight > 0)).toBe(true);
      }
      const [min, max] = archetype.itemsPerBatch;
      expect(min).toBeGreaterThanOrEqual(1);
      expect(max).toBeGreaterThanOrEqual(min);
    }
  });
});

describe('interpretation lens vantage (WS-G.2.2)', () => {
  it('maps every returned vantage to a provisioned lens type', () => {
    for (const id of Object.keys(PERSONA_ARCHETYPES) as (keyof typeof PERSONA_ARCHETYPES)[]) {
      const vantage = lensVantageOf(id);
      if (vantage !== null) expect(SIM_LENS_TYPES).toContain(vantage);
    }
  });

  it('gives the main commenting archetypes a vantage and readers/authors none', () => {
    // Commenting archetypes declare a reading…
    for (const id of [
      'commenter',
      'evidence_contributor',
      'expert_author',
      'local_correspondent',
      'deep_reader',
      'reporter',
      'newcomer',
      'cluster_member',
    ] as const) {
      expect(lensVantageOf(id)).not.toBeNull();
    }
    // …pure readers and story authors declare none.
    for (const id of ['author', 'lurker', 'skimmer', 'burst_returner'] as const) {
      expect(lensVantageOf(id)).toBeNull();
    }
  });

  it('spreads the commenting archetypes across at least three distinct lenses', () => {
    const vantages = new Set(
      (Object.keys(PERSONA_ARCHETYPES) as (keyof typeof PERSONA_ARCHETYPES)[])
        .map((id) => lensVantageOf(id))
        .filter((v) => v !== null),
    );
    expect(vantages.size).toBeGreaterThanOrEqual(3);
  });

  it('names every lens type (so create-if-missing always has a name)', () => {
    for (const type of SIM_LENS_TYPES) {
      expect(SIM_LENS_NAMES[type]).toBeTruthy();
    }
  });
});
