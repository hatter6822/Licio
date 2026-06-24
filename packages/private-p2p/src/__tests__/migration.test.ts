// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — server→private migration planning (PRIVATE_SPEC §24.2).

import { describe, expect, it } from 'vitest';
import { type MigrationSourceItem, planMigration } from '../engine/migration.js';

const items: MigrationSourceItem[] = [
  { id: 's1', kind: 'story', title: 'Story One', summary: 'sum1', body: 'body1', threadRef: 't1' },
  { id: 'c1', kind: 'contribution', body: 'reply body', threadRef: 't1', parentRef: 's1' },
  { id: 's2', kind: 'story', title: 'Story Two', body: 'body2', threadRef: 't2' },
];

describe('WS-S.9 planMigration', () => {
  it('fresh imports nothing and carries no plaintext', () => {
    const plan = planMigration({ mode: 'fresh', items });
    expect(plan.items).toEqual([]);
    expect(plan.carriesPlaintextBodies).toBe(false);
    expect(plan.disclosure.toLowerCase()).toContain('best privacy');
  });

  it('full imports every item with full bodies', () => {
    const plan = planMigration({ mode: 'full', items });
    expect(plan.items.map((i) => i.id)).toEqual(['s1', 'c1', 's2']);
    expect(plan.items[0]?.body).toBe('body1');
    expect(plan.carriesPlaintextBodies).toBe(true);
    expect(plan.disclosure.toLowerCase()).toContain('server');
  });

  it('selected imports only the chosen ids with full bodies', () => {
    const plan = planMigration({ mode: 'selected', items, selectedIds: ['s1', 'c1'] });
    expect(plan.items.map((i) => i.id)).toEqual(['s1', 'c1']);
    expect(plan.items.find((i) => i.id === 'c1')?.body).toBe('reply body');
    expect(plan.carriesPlaintextBodies).toBe(true);
  });

  it('selecting a STORY also brings its thread comments (no shell-without-conversation)', () => {
    // The wizard only checks story ids; selecting `s1` must carry `c1` (its thread `t1` comment),
    // but NOT `s2`/its thread.
    const plan = planMigration({ mode: 'selected', items, selectedIds: ['s1'] });
    expect(plan.items.map((i) => i.id).sort()).toEqual(['c1', 's1']);
    expect(plan.items.find((i) => i.id === 'c1')?.body).toBe('reply body');
  });

  it('selected with no selection imports nothing', () => {
    expect(planMigration({ mode: 'selected', items }).items).toEqual([]);
  });

  it('redacted carries titles/summaries only — bodies are stripped', () => {
    const plan = planMigration({ mode: 'redacted', items });
    expect(plan.items.map((i) => i.id)).toEqual(['s1', 'c1', 's2']);
    expect(plan.items.every((i) => i.body === undefined)).toBe(true);
    expect(plan.items.find((i) => i.id === 's1')?.title).toBe('Story One');
    expect(plan.items.find((i) => i.id === 's1')?.summary).toBe('sum1');
    expect(plan.carriesPlaintextBodies).toBe(false);
    expect(plan.disclosure.toLowerCase()).toContain('lower leakage');
  });

  it('preserves the structural refs needed to rebuild the DAG', () => {
    const plan = planMigration({ mode: 'full', items });
    const reply = plan.items.find((i) => i.id === 'c1');
    expect(reply?.threadRef).toBe('t1');
    expect(reply?.parentRef).toBe('s1');
  });
});
