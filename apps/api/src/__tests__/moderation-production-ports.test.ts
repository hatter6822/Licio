// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J production ports: removals actually propagate to the WS-E item-safety
// state (the ranking-exclusion seam) + the WS-G contribution state; account
// actions write the WS-D state; user resolution reads handle + account age.
import type { ModerationCaseCreatedEvent } from '@licio/shared';
import { describe, expect, it, vi } from 'vitest';
import type { NewStoredEvent } from '../events/stores.js';
import { InMemoryItemSafetyStateStore } from '../events/stores.js';
import {
  type ContentPortDeps,
  createProductionContentPort,
  createProductionEventPort,
  createProductionInvariantPort,
  createProductionUserPort,
  type InvariantOutputRead,
} from '../moderation/production-ports.js';

const STORY = '00000000-0000-4000-8000-00000000000a';
const CONTRIB = '00000000-0000-4000-8000-00000000000b';
const AUTHOR = '00000000-0000-4000-8000-00000000000c';

function contentDeps(over: Partial<ContentPortDeps> = {}): ContentPortDeps {
  return {
    safetyStore: new InMemoryItemSafetyStateStore(),
    getStory: async (id) => (id === STORY ? { submittedBy: AUTHOR } : null),
    getContribution: async (id) => (id === CONTRIB ? { userId: AUTHOR } : null),
    setContributionModerationState: vi.fn(async () => undefined),
    setAccountState: vi.fn(async () => undefined),
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe('production content port', () => {
  it('resolves a story target to its submitter and a contribution to its author', async () => {
    const port = createProductionContentPort(contentDeps());
    expect(await port.resolveTarget('content', STORY)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: 'story',
    });
    expect(await port.resolveTarget('content', CONTRIB)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: 'contribution',
    });
    expect(await port.resolveTarget('account', AUTHOR)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: null,
    });
    expect(
      (await port.resolveTarget('content', '00000000-0000-4000-8000-0000000000ff')).exists,
    ).toBe(false);
  });

  it('removal writes the WS-E item-safety state to removed (the ranking seam)', async () => {
    const safetyStore = new InMemoryItemSafetyStateStore();
    const setState = vi.fn(async () => undefined);
    const port = createProductionContentPort(
      contentDeps({ safetyStore, setContributionModerationState: setState }),
    );
    await port.applyContentState(STORY, 'story', 'removed', 'case-1', 'mod-1');
    expect((await safetyStore.get(STORY))?.safetyState).toBe('removed');

    await port.applyContentState(CONTRIB, 'contribution', 'hidden', null, 'mod-1');
    expect((await safetyStore.get(CONTRIB))?.safetyState).toBe('removed'); // hidden also excludes
    expect(setState).toHaveBeenCalledWith(CONTRIB, 'hidden');

    // A revert restores the item to normal.
    await port.applyContentState(STORY, 'story', 'visible', 'case-1', 'mod-1');
    expect((await safetyStore.get(STORY))?.safetyState).toBe('normal');
  });

  it('account action writes the coarse WS-D account state', async () => {
    const setAccountState = vi.fn(async () => undefined);
    const port = createProductionContentPort(contentDeps({ setAccountState }));
    await port.applyAccountState(AUTHOR, 'banned', null);
    expect(setAccountState).toHaveBeenCalledWith(AUTHOR, 'suspended');
    await port.applyAccountState(AUTHOR, 'active', null);
    expect(setAccountState).toHaveBeenCalledWith(AUTHOR, 'active');
  });
});

describe('production event port', () => {
  const CASE = '00000000-0000-4000-8000-00000000000d';
  const REPORTER = '00000000-0000-4000-8000-00000000000e';

  it('persists durably THEN publishes a valid moderation.case.created (restricted)', async () => {
    const persisted: NewStoredEvent[] = [];
    const published: ModerationCaseCreatedEvent[] = [];
    const port = createProductionEventPort({
      persist: async (e) => {
        // Publish must not have happened before the durable write.
        expect(published).toHaveLength(0);
        persisted.push(e);
      },
      publish: async (e) => {
        published.push(e);
      },
    });
    await port.caseCreated({
      caseId: CASE,
      targetType: 'content',
      contentKind: 'contribution',
      targetId: CONTRIB,
      reporterId: REPORTER,
      reasonCode: 'MOD_HARASS_001',
      severity: 'high',
      source: 'user_report',
      nowIso: '2026-06-16T00:00:00.000Z',
    });
    expect(persisted).toHaveLength(1);
    expect(published).toHaveLength(1);
    const stored = persisted[0];
    expect(stored?.topic).toBe('moderation.case.created');
    expect(stored?.privacyClassification).toBe('restricted');
    expect(stored?.retentionTier).toBe('moderation_legal');
    expect(stored?.ownerUserId).toBeNull(); // never DSAR-linked
    const event = published[0];
    expect(event?.target_type).toBe('contribution');
    expect(event?.reporter_id).toBe(REPORTER);
    expect(event?.case_id).toBe(CASE);
  });

  it('maps target/content-kind onto the event scale (account→user, story→story)', async () => {
    const published: ModerationCaseCreatedEvent[] = [];
    const port = createProductionEventPort({
      persist: async () => undefined,
      publish: async (e) => {
        published.push(e);
      },
    });
    await port.caseCreated({
      caseId: CASE,
      targetType: 'account',
      contentKind: null,
      targetId: AUTHOR,
      reporterId: null, // automated detection
      reasonCode: 'MOD_SPAM_001',
      severity: 'medium',
      source: 'automated',
      nowIso: '2026-06-16T00:00:00.000Z',
    });
    expect(published[0]?.target_type).toBe('user');
    expect(published[0]?.reporter_id).toBeNull();
    expect(published[0]?.source).toBe('automated');
  });
});

describe('production invariant port (WS-J.2.2c)', () => {
  const TARGET = '00000000-0000-4000-8000-00000000000a';
  const SUBJECT = '00000000-0000-4000-8000-00000000000c';

  function output(
    scoreVector: Record<string, unknown>,
    summary: string | null,
  ): InvariantOutputRead {
    return { scoreVector, explanationSummary: summary, coverage: 1, reasonCodes: [] };
  }

  it('maps WS-H outputs onto the four signals; MFCI detail is role-gated', async () => {
    const port = createProductionInvariantPort({
      mfciRiskState: async (id) =>
        id === TARGET ? { state: 'elevated', score: 0.91, reason: 'fiber p<0.01' } : null,
      latestOutput: async (type, id) => {
        if (type === 'SCOI' && id === TARGET)
          return output({ context_state: 'weaponized' }, 'Interpretations diverge sharply.');
        if (type === 'hodge_tension' && id === TARGET)
          return output(
            { label: 'structural-conflict', harmful_tension_risk: 0.4 },
            'Flow conflict.',
          );
        if (type === 'PHI' && id === SUBJECT) return output({ phi: 0.7 }, 'Frame rotated.');
        return null;
      },
    });
    // Community steward: state only, no coordination detail.
    const steward = await port.signalsFor('content', TARGET, SUBJECT, false);
    expect(steward.mfci).toEqual({ available: true, state: 'elevated', detail: null });
    expect(steward.scoi.state).toBe('weaponized');
    expect(steward.hodge.state).toBe('structural-conflict');
    expect(steward.phi.state).toBe('personalization-narrowing');
    expect(steward.disclaimer).toContain('do not determine outcomes');
    // Integrity analyst: MFCI detail present.
    const analyst = await port.signalsFor('content', TARGET, SUBJECT, true);
    expect(analyst.mfci.detail).toContain('fiber p<0.01');
    expect(analyst.mfci.detail).toContain('0.910');
  });

  it('surfaces "unavailable" (not zero) when an output is missing or degraded', async () => {
    const port = createProductionInvariantPort({
      mfciRiskState: async () => null,
      latestOutput: async () => null,
    });
    const panel = await port.signalsFor('account', SUBJECT, SUBJECT, true);
    expect(panel.mfci.available).toBe(false);
    expect(panel.scoi).toEqual({ available: false, state: null, detail: null });
    expect(panel.phi.available).toBe(false);
    expect(panel.hodge.available).toBe(false);
  });

  it('falls back to the subject account for MFCI when the target carries none', async () => {
    const port = createProductionInvariantPort({
      mfciRiskState: async (id) =>
        id === SUBJECT ? { state: 'high', score: 0.97, reason: 'account-level' } : null,
      latestOutput: async () => null,
    });
    const panel = await port.signalsFor('content', TARGET, SUBJECT, false);
    expect(panel.mfci).toEqual({ available: true, state: 'high', detail: null });
  });
});

describe('production user port', () => {
  it('resolves handle + account age (days) and batches', async () => {
    const nowMs = 1_700_000_000_000;
    const created = new Date(nowMs - 10 * 86_400_000).toISOString();
    const port = createProductionUserPort({
      getUser: async (id) => (id === AUTHOR ? { handle: 'alice', createdAt: created } : null),
      getUsersByIds: async (ids) =>
        ids.includes(AUTHOR) ? [{ userId: AUTHOR, handle: 'alice', createdAt: created }] : [],
      now: () => nowMs,
    });
    const resolved = await port.resolve(AUTHOR);
    expect(resolved?.handle).toBe('alice');
    expect(resolved?.accountAgeDays).toBe(10);
    expect(await port.resolve('00000000-0000-4000-8000-0000000000ff')).toBeNull();
    const many = await port.resolveMany([AUTHOR]);
    expect(many.get(AUTHOR)?.accountAgeDays).toBe(10);
  });
});
