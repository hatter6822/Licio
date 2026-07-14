// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.4.1g — the room-readiness gate for governance-mode transitions
// (SPEC §16.5, §17.11, §30.7 K1).  A room cannot leave `simulated` for any
// real-asset mode until EVERY readiness item verifies:
//
//  WS-M.1.2-owned items (consumed via the checklist port, FAIL-CLOSED — an
//  unwired item verifies false, keeping the room in the safer mode):
//   charter present · stewards designated · treasury policy defined ·
//   safety override acknowledged
//
//  WS-L-owned simulation evidence:
//   comprehension passed by the requesting steward (WS-L.4.1e) ·
//   a minimum simulated-governance track record in the audit log (WS-L.4.1f)
//
// A failed transition returns the SPECIFIC unmet items; the gate decision and
// its inputs are recorded for audit; only authorized stewards/staff can
// request a transition, and the request itself is audit-logged.

import type { GovernanceMode, ReadinessRequirement } from '@licio/shared';
import type { AuditStore } from '../identity/audit.js';
import type { KnomosisRuntimeConfig } from './config.js';
import { hasPassedComprehension } from './simulation.js';
import type { ComprehensionStore, GovernanceAuditStore } from './stores.js';

/** WS-M.1.2 checklist seam (defaults FAIL CLOSED until WS-M ships). */
export interface ReadinessChecklistPort {
  checklist(roomId: string): Promise<{
    charterPresent: boolean;
    stewardsDesignated: boolean;
    treasuryPolicyDefined: boolean;
    safetyOverrideAcknowledged: boolean;
  }>;
}

export const failClosedReadinessChecklistPort: ReadinessChecklistPort = {
  checklist: async () => ({
    charterPresent: false,
    stewardsDesignated: false,
    treasuryPolicyDefined: false,
    safetyOverrideAcknowledged: false,
  }),
};

/** Room governance-mode read/write seam (wired to the forum room store). */
export interface RoomModePort {
  currentMode(roomId: string): Promise<GovernanceMode | null>;
  setMode(roomId: string, mode: GovernanceMode): Promise<boolean>;
}

export interface ReadinessDeps {
  checklist: ReadinessChecklistPort;
  roomMode: RoomModePort;
  governanceAudit: GovernanceAuditStore;
  comprehension: ComprehensionStore;
  audit: AuditStore;
  config: () => KnomosisRuntimeConfig;
  now: () => number;
  uuid: () => string;
}

export interface UnmetRequirement {
  requirement: ReadinessRequirement;
  description: string;
}

/** Evaluate the full checklist for a (room, requesting steward) pair. */
export async function evaluateReadiness(
  deps: ReadinessDeps,
  roomId: string,
  requestingUserId: string,
): Promise<{ ready: boolean; unmet: UnmetRequirement[] }> {
  const unmet: UnmetRequirement[] = [];
  const checklist = await deps.checklist.checklist(roomId);
  if (!checklist.charterPresent) {
    unmet.push({
      requirement: 'charter_present',
      description: 'The room needs a plain-language charter.',
    });
  }
  if (!checklist.stewardsDesignated) {
    unmet.push({
      requirement: 'stewards_designated',
      description: 'The room needs designated stewards.',
    });
  }
  if (!checklist.treasuryPolicyDefined) {
    unmet.push({
      requirement: 'treasury_policy_defined',
      description: 'The room needs a treasury policy with permitted spend categories and caps.',
    });
  }
  if (!checklist.safetyOverrideAcknowledged) {
    unmet.push({
      requirement: 'safety_override_acknowledged',
      description:
        'The room must acknowledge the platform safety override (platform-wide moderation and legal compliance prevail).',
    });
  }
  if (!(await hasPassedComprehension(deps, requestingUserId))) {
    unmet.push({
      requirement: 'comprehension_passed',
      description: 'The requesting steward must pass the simulation-comprehension check.',
    });
  }
  const trackRecord = await deps.governanceAudit.countQualifyingByRoom(roomId);
  if (trackRecord < deps.config().readinessMinSimActions) {
    unmet.push({
      requirement: 'simulation_track_record',
      description: `The room needs at least ${deps.config().readinessMinSimActions} simulated governance actions in its audit log (currently ${trackRecord}).`,
    });
  }
  return { ready: unmet.length === 0, unmet };
}

export type ModeTransitionOutcome =
  | { ok: true; mode: GovernanceMode }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: string;
      message: string;
      unmet?: UnmetRequirement[];
    };

/** The permitted transition edges this gate controls (everything else 409s). */
const PERMITTED_TRANSITIONS: ReadonlyArray<{
  from: GovernanceMode;
  to: GovernanceMode;
  requiresReadiness: boolean;
}> = [
  // Entering simulation is the safe direction — no readiness required.
  { from: 'ordinary', to: 'simulated', requiresReadiness: false },
  // Leaving simulation for the first real-asset mode requires the FULL gate.
  { from: 'simulated', to: 'testnet', requiresReadiness: true },
];

/**
 * Request a governance-mode transition (steward/staff-authorized at the
 * route).  Fail-closed: any unverified requirement keeps the current mode.
 */
export async function requestModeTransition(
  deps: ReadinessDeps,
  // Any GovernanceMode may be REQUESTED; edges outside PERMITTED_TRANSITIONS
  // 409 with `transition_not_permitted` (fail-closed until WS-M wires them).
  args: { roomId: string; targetMode: GovernanceMode; userId: string; reason: string },
): Promise<ModeTransitionOutcome> {
  const current = await deps.roomMode.currentMode(args.roomId);
  if (current === null) {
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  }
  const nowIso = new Date(deps.now()).toISOString();
  await deps.governanceAudit.append({
    entryId: deps.uuid(),
    roomId: args.roomId,
    actionType: 'mode_transition_requested',
    actorUserId: args.userId,
    actionDetails: { from: current, to: args.targetMode, reason: args.reason },
    simulationMode: current === 'simulated' || current === 'ordinary',
    createdAt: nowIso,
  });

  const edge = PERMITTED_TRANSITIONS.find((t) => t.from === current && t.to === args.targetMode);
  if (!edge) {
    return {
      ok: false,
      status: 409,
      code: 'transition_not_permitted',
      message: `A transition from "${current}" to "${args.targetMode}" is not permitted here.`,
    };
  }

  if (edge.requiresReadiness) {
    const readiness = await evaluateReadiness(deps, args.roomId, args.userId);
    // The gate decision AND its inputs are recorded for audit (WS-L.4.1g).
    await deps.audit.append({
      actorUserId: args.userId,
      eventType: 'governance_mode_change',
      targetRef: args.roomId,
      context: {
        setting: `${current}->${args.targetMode}`,
        new_value: readiness.ready
          ? 'ready'
          : `unmet:${readiness.unmet.map((u) => u.requirement).join(',')}`.slice(0, 256),
      },
    });
    if (!readiness.ready) {
      return {
        ok: false,
        status: 409,
        code: 'readiness_unmet',
        message: 'The room does not meet the readiness checklist for this transition.',
        unmet: readiness.unmet,
      };
    }
  } else {
    await deps.audit.append({
      actorUserId: args.userId,
      eventType: 'governance_mode_change',
      targetRef: args.roomId,
      context: { setting: `${current}->${args.targetMode}`, new_value: 'permitted' },
    });
  }

  const applied = await deps.roomMode.setMode(args.roomId, args.targetMode);
  if (!applied) {
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  }
  await deps.governanceAudit.append({
    entryId: deps.uuid(),
    roomId: args.roomId,
    actionType: 'mode_transition_applied',
    actorUserId: args.userId,
    actionDetails: { from: current, to: args.targetMode },
    simulationMode: args.targetMode === 'simulated',
    createdAt: new Date(deps.now()).toISOString(),
  });
  return { ok: true, mode: args.targetMode };
}
