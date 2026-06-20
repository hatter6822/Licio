// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U capability model (SPEC §24.6; ADR-5). The in-room AI agent runs under a
// deny-by-default capability descriptor. Capabilities are enforced *outside* the
// model: the runtime/kernel gates every effect against this descriptor, so the
// model cannot escalate by being "convinced" (prompt injection has no authority
// channel). The grantable-capability enum and the floor-reserved-action set are
// **disjoint by construction**: a floor-reserved action is not a member of the
// `Capability` type, so it is structurally inexpressible in any bundle, law-pack,
// or descriptor — the WS-U.3.6a guarantee at the type level.

import { z } from 'zod';

/**
 * The closed set of capabilities a room may grant its agent. Floor-reserved
 * platform duties (illegal-content reinstatement, report suppression, cross-room
 * action, key handling, safety override) are deliberately ABSENT — they are not
 * members of this type and therefore cannot appear in any descriptor.
 */
export const capabilitySchema = z.enum([
  // Moderation (Stage 3) — bounded in-room actions only; each maps to a legal
  // §15.4 conversation/safety transition the human console also emits.
  'moderate.flag',
  'moderate.warn',
  'moderate.restrict',
  'moderate.remove',
  'moderate.restore',
  // Lawmaking facilitation (Stage 4) — NO vote/tally/weight capability exists,
  // so the agent is structurally unable to compute or bias an outcome (ADR-8).
  'lawmaking.summarize',
  'lawmaking.schedule',
  'lawmaking.attest',
  // Treasury (Stage 5) — submission of signed action intents only; the agent
  // never holds keys (ADR-4). Execution authority is the kernel/contract.
  'treasury.report',
  'treasury.distribute',
  'treasury.grant',
  'treasury.invest',
  'gateway.submit_signed_action',
]);
export type Capability = z.infer<typeof capabilitySchema>;

/** Every grantable capability, for enumeration and exhaustiveness tests. */
export const GRANTABLE_CAPABILITIES: readonly Capability[] = capabilitySchema.options;

/**
 * Floor-reserved platform actions (SPEC §17.1 boundary 5, §16.3). These are
 * documented as a NON-`Capability` constant precisely to prove they are disjoint
 * from the grantable set; no derivation can ever place one in a descriptor.
 */
export const FLOOR_RESERVED_ACTIONS = [
  'floor.reinstate_removed_by_platform',
  'floor.suppress_mandatory_report',
  'floor.act_cross_room',
  'floor.handle_private_keys',
  'floor.override_platform_safety',
] as const;
export type FloorReservedAction = (typeof FLOOR_RESERVED_ACTIONS)[number];

/** The agent's deny-by-default capability descriptor (WS-U.2.4b). */
export const capabilityDescriptorSchema = z.object({
  granted: z.array(capabilitySchema),
});
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;
