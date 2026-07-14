// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M pure lifecycle tables (SPEC §22.2, §17.4).  The payment-intent state
// machine (13 states) and the governance-mode transition table are DATA here —
// deterministic, I/O-free — so the api services, the client display logic, and
// the tests all consult one source of truth.  The api layer is the single
// WRITER of these states; this module only answers "is this edge legal, and
// what gate does it require?".

// ---------------------------------------------------------------------------
// Payment-intent lifecycle (WS-M.3.1b; SPEC §22.2 — 13 states).
// ---------------------------------------------------------------------------

export const PAYMENT_INTENT_STATES = [
  'created',
  'preflighted',
  'quoted',
  'signed',
  'submitted',
  'pending',
  'confirmed',
  'finalized',
  'reverted',
  'reorged',
  'disputed',
  'abandoned',
  'failed',
] as const;
export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number];

/** The authoritative transition table (WS-M.3.1b).  Anything absent is illegal. */
const PAYMENT_INTENT_EDGES: Readonly<Record<PaymentIntentState, readonly PaymentIntentState[]>> = {
  created: ['preflighted', 'abandoned'],
  preflighted: ['quoted', 'abandoned'],
  quoted: ['signed', 'abandoned'],
  signed: ['submitted', 'abandoned'],
  submitted: ['pending', 'failed'],
  pending: ['confirmed', 'reverted'],
  confirmed: ['finalized', 'reorged'],
  finalized: ['disputed'],
  reverted: ['created'],
  reorged: ['pending', 'abandoned'],
  failed: ['created'],
  disputed: [],
  abandoned: [],
};

export function paymentIntentTransitionAllowed(
  from: PaymentIntentState,
  to: PaymentIntentState,
): boolean {
  return PAYMENT_INTENT_EDGES[from].includes(to);
}

/** States that cannot transition further (WS-M.3.1b).  `finalized` is terminal
 *  except for the post-finality dispute edge; `failed`/`reverted` are terminal
 *  once the retry budget is exhausted (the service enforces the budget). */
export const PAYMENT_INTENT_TERMINAL_STATES: ReadonlySet<PaymentIntentState> = new Set([
  'disputed',
  'abandoned',
]);

/** Pre-submission states that expire to `abandoned` on their per-state timeout. */
export const PAYMENT_INTENT_TIMED_STATES = ['created', 'preflighted', 'quoted', 'signed'] as const;
export type PaymentIntentTimedState = (typeof PAYMENT_INTENT_TIMED_STATES)[number];

/** Retry edges (`failed`/`reverted` → `created`) are bounded by this default. */
export const PAYMENT_INTENT_DEFAULT_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Governance-mode transitions (WS-M.1.1b; SPEC §17.4).
// ---------------------------------------------------------------------------

export const GOVERNANCE_MODES_ORDERED = [
  'ordinary',
  'simulated',
  'testnet',
  'capped_production',
  'mature_production',
  'frozen',
  'migrating',
] as const;
export type GovernanceModeName = (typeof GOVERNANCE_MODES_ORDERED)[number];

/**
 * What an accepted edge requires.
 *  - `free`             — no readiness gate (entering simulation is the safe
 *                         direction; SPEC §16.5 — shipped WS-L.4.1g behavior).
 *  - `rollback`         — a de-escalation back to a safer mode; no gate.
 *  - `readiness`        — the full WS-M.1.2e checklist for the TARGET mode.
 *  - `emergency`        — the emergency freeze path (platform/steward authorized,
 *                         audited; available from every non-terminal mode).
 *  - `post_remediation` — leaving `frozen` after a remediation review.
 *  - `resume`           — leaving `migrating` back to capped production
 *                         (readiness re-evaluated for the target).
 */
export type ModeTransitionGate =
  | 'free'
  | 'rollback'
  | 'readiness'
  | 'emergency'
  | 'post_remediation'
  | 'resume';

export interface ModeEdge {
  from: GovernanceModeName;
  to: GovernanceModeName;
  gate: ModeTransitionGate;
}

/** The authoritative WS-M.1.1b edge table.  Any pair not listed is illegal. */
export const GOVERNANCE_MODE_EDGES: readonly ModeEdge[] = [
  { from: 'ordinary', to: 'simulated', gate: 'free' },
  { from: 'simulated', to: 'ordinary', gate: 'rollback' },
  { from: 'simulated', to: 'testnet', gate: 'readiness' },
  { from: 'testnet', to: 'ordinary', gate: 'rollback' },
  { from: 'testnet', to: 'capped_production', gate: 'readiness' },
  { from: 'capped_production', to: 'mature_production', gate: 'readiness' },
  // Emergency freeze from every active mode.
  { from: 'ordinary', to: 'frozen', gate: 'emergency' },
  { from: 'simulated', to: 'frozen', gate: 'emergency' },
  { from: 'testnet', to: 'frozen', gate: 'emergency' },
  { from: 'capped_production', to: 'frozen', gate: 'emergency' },
  { from: 'mature_production', to: 'frozen', gate: 'emergency' },
  { from: 'migrating', to: 'frozen', gate: 'emergency' },
  // Remediation + migration paths.
  { from: 'frozen', to: 'migrating', gate: 'post_remediation' },
  { from: 'migrating', to: 'capped_production', gate: 'resume' },
  { from: 'migrating', to: 'ordinary', gate: 'rollback' },
];

/** The gate an edge requires, or null when the edge is illegal. */
export function modeTransitionGate(
  from: GovernanceModeName,
  to: GovernanceModeName,
): ModeTransitionGate | null {
  const edge = GOVERNANCE_MODE_EDGES.find((e) => e.from === from && e.to === to);
  return edge?.gate ?? null;
}

// ---------------------------------------------------------------------------
// Proposal challenge lifecycle (WS-M.4.3a).
// ---------------------------------------------------------------------------

export const CHALLENGE_TYPES = ['coi', 'fraud', 'capture', 'legal', 'evidence_defect'] as const;
export type ChallengeType = (typeof CHALLENGE_TYPES)[number];

export const CHALLENGE_STATES = ['open', 'upheld', 'dismissed', 'escalated'] as const;
export type ChallengeState = (typeof CHALLENGE_STATES)[number];

const CHALLENGE_EDGES: Readonly<Record<ChallengeState, readonly ChallengeState[]>> = {
  open: ['upheld', 'dismissed', 'escalated'],
  // Platform escalation resolves back to a final disposition (WS-J review).
  escalated: ['upheld', 'dismissed'],
  upheld: [],
  dismissed: [],
};

export function challengeTransitionAllowed(from: ChallengeState, to: ChallengeState): boolean {
  return CHALLENGE_EDGES[from].includes(to);
}

/** Challenge types that ALWAYS carry a platform-escalation path (WS-M.4.3a):
 *  legal and capture concerns must be able to reach platform actors, never be
 *  buried at room level. */
export const PLATFORM_ESCALATING_CHALLENGE_TYPES: ReadonlySet<ChallengeType> = new Set([
  'legal',
  'capture',
]);
