// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-E.2.2b conservative accusation classifier + WS-E.2.1d plain-language
// summaries. The classifier tests pin the conservative bias: ordinary opinion,
// disagreement, questions, hedges, and reported speech are NEVER classified.
import { describe, expect, it } from 'vitest';
import { buildLedgerSummary, classifyAccusationV0 } from '../index.js';

describe('classifyAccusationV0 (WS-E.2.2b)', () => {
  it('classifies direct, unhedged assertions of serious wrongdoing', () => {
    expect(classifyAccusationV0('They committed fraud last quarter.')).toBe(true);
    expect(classifyAccusationV0('Acme Corp is a scam and stole customer funds.')).toBe(true);
    expect(classifyAccusationV0('He embezzled the room treasury.')).toBe(true);
    expect(classifyAccusationV0('You are a criminal.')).toBe(true);
  });

  it('never classifies ordinary opinion or routine disagreement', () => {
    expect(classifyAccusationV0('I disagree with this policy decision.')).toBe(false);
    expect(classifyAccusationV0('This argument is weak and the data is outdated.')).toBe(false);
    expect(classifyAccusationV0('Strongly worded, but the methodology seems off to me.')).toBe(
      false,
    );
    expect(classifyAccusationV0('The mayor should resign over this budget.')).toBe(false);
  });

  it('never classifies questions', () => {
    expect(classifyAccusationV0('Did they commit fraud?')).toBe(false);
    expect(classifyAccusationV0('Is this corruption?')).toBe(false);
  });

  it('never classifies hedged or reported statements', () => {
    expect(classifyAccusationV0('He allegedly committed fraud.')).toBe(false);
    expect(classifyAccusationV0('I think this is corrupt.')).toBe(false);
    expect(classifyAccusationV0('They may have stolen the funds.')).toBe(false);
    expect(classifyAccusationV0('According to the filing, the fund was mismanaged.')).toBe(false);
    expect(classifyAccusationV0('She was accused of bribery by the council.')).toBe(false);
  });

  it('never classifies topical discussion of wrongdoing without a subject assertion', () => {
    expect(classifyAccusationV0('The article discusses fraud prevention techniques.')).toBe(false);
    expect(classifyAccusationV0('Theft is wrong.')).toBe(false);
    expect(classifyAccusationV0('fraud')).toBe(false);
  });

  it('is total on degenerate inputs', () => {
    expect(classifyAccusationV0('')).toBe(false);
    expect(classifyAccusationV0('   ')).toBe(false);
  });
});

describe('buildLedgerSummary (WS-E.2.1d)', () => {
  it('produces the plan-shaped plain-language sentence', () => {
    const summary = buildLedgerSummary({
      dwellBucket: 'medium',
      sourceOpened: true,
      sourceBounceOnly: false,
      contextOpened: false,
      savedForLater: false,
      replyDepthBucket: 'none',
      returnVisitBucket: 'few',
      contributions: { question: 1 },
      annotations: [],
    });
    expect(summary).toBe(
      'You read this for a moderate duration, opened the source, and returned to it. ' +
        'Your question was counted as constructive participation.',
    );
  });

  it('explains bounce-only opens honestly (not counted)', () => {
    const summary = buildLedgerSummary({
      dwellBucket: 'glance',
      sourceOpened: true,
      sourceBounceOnly: true,
      contextOpened: false,
      savedForLater: false,
      replyDepthBucket: 'none',
      returnVisitBucket: 'none',
      contributions: {},
      annotations: [],
    });
    expect(summary).toContain('returned right away (not counted)');
  });

  it('surfaces anti-signal annotations transparently (§5.3 / WS-E.2.2b)', () => {
    const summary = buildLedgerSummary({
      dwellBucket: 'none',
      sourceOpened: false,
      sourceBounceOnly: false,
      contextOpened: false,
      savedForLater: false,
      replyDepthBucket: 'none',
      returnVisitBucket: 'none',
      contributions: { correction: 1 },
      annotations: ['source_free_accusation_downweight', 'rapid_repetition_dampened'],
    });
    expect(summary).toContain('downweighted: it makes a serious claim without supporting evidence');
    expect(summary).toContain('Rapid repeated replies were dampened.');
  });

  it('handles an empty window honestly', () => {
    const summary = buildLedgerSummary({
      dwellBucket: 'none',
      sourceOpened: false,
      sourceBounceOnly: false,
      contextOpened: false,
      savedForLater: false,
      replyDepthBucket: 'none',
      returnVisitBucket: 'none',
      contributions: {},
      annotations: [],
    });
    expect(summary).toBe('No attention signals were counted for this item in this window.');
  });

  it('surfaces a save-only window (SIG-ATT-SAVE) instead of "nothing counted"', () => {
    const summary = buildLedgerSummary({
      dwellBucket: 'none',
      sourceOpened: false,
      sourceBounceOnly: false,
      contextOpened: false,
      savedForLater: true,
      replyDepthBucket: 'none',
      returnVisitBucket: 'none',
      contributions: {},
      annotations: [],
    });
    expect(summary).toBe('You saved it for later.');
    expect(summary).not.toContain('No attention signals were counted');
  });

  it('surfaces a traversal-only window (SIG-ATT-TRAVERSE) instead of "nothing counted"', () => {
    const summary = buildLedgerSummary({
      dwellBucket: 'none',
      sourceOpened: false,
      sourceBounceOnly: false,
      contextOpened: false,
      savedForLater: false,
      replyDepthBucket: 'shallow',
      returnVisitBucket: 'none',
      contributions: {},
      annotations: [],
    });
    expect(summary).toBe('You read into the replies.');
    expect(summary).not.toContain('No attention signals were counted');
  });

  it('never emits applause language', () => {
    const summary = buildLedgerSummary({
      dwellBucket: 'extended',
      sourceOpened: true,
      sourceBounceOnly: false,
      contextOpened: true,
      savedForLater: false,
      replyDepthBucket: 'none',
      returnVisitBucket: 'many',
      contributions: { correction: 2, bridge_comment: 1 },
      annotations: [],
    });
    for (const forbidden of ['like', 'upvote', 'karma', 'reaction']) {
      expect(summary.toLowerCase()).not.toContain(forbidden);
    }
  });
});
