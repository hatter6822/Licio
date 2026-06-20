// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U fail-closed governance configuration (the house pattern). The crypto flag
// defaults FALSE: with it off, the treasury surface and the agent's treasury
// powers do not exist (ADR-2/6). In-room moderation + elections (simulated) need
// no crypto flag. Invalid stored values are rejected and the reviewed default is
// kept (a misconfiguration can never silently enable crypto or loosen a bound).

export interface GovernanceConfig {
  /** Fail-closed crypto gate; OFF ⇒ no treasury powers exist (ADR-2). */
  cryptoEnabled: boolean;
  /** Steward term length in seconds (one year default). */
  electionTermSeconds: number;
  /** Voting window length in seconds for a scheduled election. */
  electionWindowSeconds: number;
  /** Per-room agent invocations allowed per hour (cost/DoS bound, ADR-6). */
  agentInvocationsPerHour: number;
}

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  cryptoEnabled: false,
  electionTermSeconds: 365 * 24 * 60 * 60,
  electionWindowSeconds: 7 * 24 * 60 * 60,
  agentInvocationsPerHour: 600,
};

/** Validate a partial config patch, keeping defaults for invalid/missing values. */
export function resolveGovernanceConfig(patch?: Partial<GovernanceConfig>): GovernanceConfig {
  const base = { ...DEFAULT_GOVERNANCE_CONFIG };
  if (!patch) return base;
  if (typeof patch.cryptoEnabled === 'boolean') base.cryptoEnabled = patch.cryptoEnabled;
  if (isPositiveInt(patch.electionTermSeconds))
    base.electionTermSeconds = patch.electionTermSeconds;
  if (isPositiveInt(patch.electionWindowSeconds)) {
    base.electionWindowSeconds = patch.electionWindowSeconds;
  }
  if (isPositiveInt(patch.agentInvocationsPerHour)) {
    base.agentInvocationsPerHour = patch.agentInvocationsPerHour;
  }
  return base;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
