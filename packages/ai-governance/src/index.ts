// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @licio/ai-governance — the WS-K AI & Model Governance domain (SPEC §24). Pure
// schemas + deterministic governance logic with no I/O: model cards, the model
// registry record shapes, NIST/ISO risk assessments + the AI inventory, the
// prohibited-use guard, data lineage, audit-sensitive output records, the four
// evaluations (bias/hallucination/safety/red-team) + the harness gate, the
// content pipelines, summary quality, translation, correction/accuracy, and the
// §24.5 governance matrix. The API layer (apps/api) persists and wires these;
// the web client renders their labels. Depends only on @licio/shared.

export * from './accuracy.js';
export * from './bias-audit.js';
export * from './canonical-json.js';
export * from './debate-judge.js';
export * from './hallucination.js';
export * from './harness.js';
export * from './inventory.js';
export * from './labels.js';
export * from './prohibited-use.js';
export * from './red-team.js';
export * from './safety-suite.js';
export * from './schemas/index.js';
export * from './summary-quality.js';
export * from './summary-render.js';
export {
  containsAnyTerm,
  contentTokens,
  jaccard,
  numbersIn,
  sentenceSplit,
  tokenize,
} from './text.js';
