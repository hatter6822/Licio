// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.2d — consumer risk disclosures: versioned, publish-immutable,
// region-keyed content plus audited acknowledgment records, and the
// first-financial-action gate the shipped chokepoints call (payment-intent
// creation + the gateway fund-transfer preflight route).
//
// The gate keys off the ACTIVE jurisdiction policy's `disclosure_refs`: a
// region whose policy lists disclosures requires the CURRENT version of each
// to be acknowledged before the user's first financial action there.  No
// policy / no refs ⇒ nothing to acknowledge (the crypto cells are what gate
// availability).  Acknowledgments are append-only consent evidence (the user
// ref anonymizes on erasure; the record survives per the counsel schedule).
import type { DisclosureRef } from '@licio/shared';
import type { ActivePolicyDeps, activePolicyForRegion } from './policy.js';
import type { RegionResolution } from './region.js';
import type {
  DisclosureAckRecord,
  DisclosureAckStore,
  DisclosureStore,
  DisclosureVersionRecord,
} from './stores.js';

type Clock = () => number;

export interface DisclosureDeps {
  disclosures: DisclosureStore;
  acks: DisclosureAckStore;
  policy: ActivePolicyDeps;
  activePolicy: typeof activePolicyForRegion;
  resolveRegion: (userId: string) => Promise<RegionResolution>;
  now: Clock;
  uuid: () => string;
}

export interface DisclosureGateResult {
  required: boolean;
  region: string | null;
  /** The refs still missing an acknowledgment of the CURRENT version. */
  missing: DisclosureRef[];
}

/**
 * The WS-N.1.2d acknowledgment gate.  Fail-closed: an ack-store outage
 * reports the full requirement set as missing (the caller rejects the
 * financial action), never a silent pass.
 */
export async function disclosureGate(
  deps: DisclosureDeps,
  userId: string,
): Promise<DisclosureGateResult> {
  const resolution = await deps.resolveRegion(userId);
  if (resolution.region === null) return { required: false, region: null, missing: [] };
  const outcome = await deps.activePolicy(deps.policy, resolution.region);
  if (outcome.kind !== 'active' || outcome.policy.disclosure_refs.length === 0) {
    return { required: false, region: resolution.region, missing: [] };
  }
  const missing: DisclosureRef[] = [];
  for (const ref of outcome.policy.disclosure_refs) {
    let acknowledged = false;
    try {
      acknowledged = await deps.acks.has(userId, ref.id, ref.version);
    } catch {
      acknowledged = false; // fail-closed
    }
    if (!acknowledged) missing.push(ref);
  }
  return { required: missing.length > 0, region: resolution.region, missing };
}

export type DisclosureError = { ok: false; status: number; code: string; message: string };

/** Record one acknowledgment (idempotent).  The version must actually be
 *  published for the user's region — a client cannot acknowledge a
 *  non-existent or foreign-region version into the gate. */
export async function acknowledgeDisclosure(
  deps: DisclosureDeps,
  input: { userId: string; disclosureId: string; version: number },
): Promise<DisclosureError | { ok: true; record: DisclosureAckRecord }> {
  const resolution = await deps.resolveRegion(input.userId);
  if (resolution.region === null) {
    return {
      ok: false,
      status: 409,
      code: 'unknown_region',
      message: 'Declare a region before acknowledging disclosures.',
    };
  }
  const version = await deps.disclosures.get(input.disclosureId, resolution.region, input.version);
  if (version === null) {
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  }
  const record = await deps.acks.record({
    id: deps.uuid(),
    userId: input.userId,
    disclosureId: input.disclosureId,
    version: input.version,
    region: resolution.region,
    acknowledgedAt: new Date(deps.now()).toISOString(),
  });
  return { ok: true, record };
}

/** The user-facing list: the region's published disclosures + ack status. */
export async function listDisclosuresForUser(
  deps: DisclosureDeps,
  userId: string,
): Promise<Array<DisclosureVersionRecord & { acknowledged: boolean }>> {
  const resolution = await deps.resolveRegion(userId);
  if (resolution.region === null) return [];
  const versions = await deps.disclosures.listForRegion(resolution.region);
  const out: Array<DisclosureVersionRecord & { acknowledged: boolean }> = [];
  for (const version of versions) {
    let acknowledged = false;
    try {
      acknowledged = await deps.acks.has(userId, version.disclosureId, version.version);
    } catch {
      acknowledged = false;
    }
    out.push({ ...version, acknowledged });
  }
  return out;
}
