// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U capability derivation (SPEC §24.6; ADR-5, WS-U.2.4b). The agent's
// deny-by-default descriptor = requested ∩ grantable ∩ law-pack-permitted, in
// stable order, de-duplicated. Floor-reserved actions are not members of the
// `Capability` type, so they cannot be requested, permitted, or granted — the
// WS-U.3.6a structural guarantee. There is no path by which a derivation places
// a floor-reserved action in a descriptor.

import {
  type Capability,
  type CapabilityDescriptor,
  GRANTABLE_CAPABILITIES,
} from './schemas/capability.js';
import type { LawPack } from './schemas/law-pack.js';

export function deriveCapabilityDescriptor(
  requested: readonly Capability[],
  lawPack: Pick<LawPack, 'permittedCapabilities'>,
): CapabilityDescriptor {
  const grantable = new Set<Capability>(GRANTABLE_CAPABILITIES);
  const permitted = new Set<Capability>(lawPack.permittedCapabilities);
  const granted: Capability[] = [];
  for (const cap of requested) {
    if (grantable.has(cap) && permitted.has(cap) && !granted.includes(cap)) {
      granted.push(cap);
    }
  }
  return { granted };
}

/** True iff the descriptor grants the capability (the runtime's gate). */
export function hasCapability(descriptor: CapabilityDescriptor, capability: Capability): boolean {
  return descriptor.granted.includes(capability);
}
