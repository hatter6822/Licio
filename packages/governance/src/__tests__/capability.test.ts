// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { deriveCapabilityDescriptor, hasCapability } from '../capability-derive.js';
import {
  type Capability,
  FLOOR_RESERVED_ACTIONS,
  GRANTABLE_CAPABILITIES,
} from '../schemas/capability.js';
import type { LawPack } from '../schemas/law-pack.js';

const lawPack = (permitted: Capability[]): Pick<LawPack, 'permittedCapabilities'> => ({
  permittedCapabilities: permitted,
});

describe('capability model (structural floor guarantee)', () => {
  it('keeps grantable capabilities and floor-reserved actions disjoint by construction', () => {
    const floor = new Set<string>(FLOOR_RESERVED_ACTIONS);
    for (const cap of GRANTABLE_CAPABILITIES) {
      expect(floor.has(cap)).toBe(false);
    }
    // No grantable capability is in the floor namespace, and vice versa.
    expect(GRANTABLE_CAPABILITIES.some((c) => c.startsWith('floor.'))).toBe(false);
    expect(FLOOR_RESERVED_ACTIONS.every((a) => a.startsWith('floor.'))).toBe(true);
  });

  it('derives the descriptor as requested ∩ permitted, de-duplicated, in order', () => {
    const requested: Capability[] = [
      'moderate.remove',
      'moderate.warn',
      'moderate.remove',
      'treasury.grant',
    ];
    const descriptor = deriveCapabilityDescriptor(
      requested,
      lawPack(['moderate.remove', 'moderate.warn']),
    );
    expect(descriptor.granted).toEqual(['moderate.remove', 'moderate.warn']);
    expect(hasCapability(descriptor, 'moderate.remove')).toBe(true);
    expect(hasCapability(descriptor, 'treasury.grant')).toBe(false);
  });

  it('grants nothing the law-pack does not permit', () => {
    const descriptor = deriveCapabilityDescriptor(['treasury.invest'], lawPack([]));
    expect(descriptor.granted).toEqual([]);
  });

  it('treats debate.judge as an ordinary grantable, floor-disjoint capability (WS-T)', () => {
    expect(GRANTABLE_CAPABILITIES).toContain('debate.judge');
    expect(new Set<string>(FLOOR_RESERVED_ACTIONS).has('debate.judge')).toBe(false);
    // Deny-by-default: unrequested or unpermitted ⇒ not granted.
    expect(deriveCapabilityDescriptor(['debate.judge'], lawPack([])).granted).toEqual([]);
    // Requested AND law-pack-permitted ⇒ granted; the runtime gate then sees it.
    const descriptor = deriveCapabilityDescriptor(['debate.judge'], lawPack(['debate.judge']));
    expect(descriptor.granted).toEqual(['debate.judge']);
    expect(hasCapability(descriptor, 'debate.judge')).toBe(true);
  });
});
