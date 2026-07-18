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
  /** The requirement could not be READ — either the region resolution failed
   *  (a declaration-store outage, `RegionResolution.unavailable`) or the policy
   *  store was unavailable — so the route fails closed (503), never a silent
   *  pass. */
  unavailable?: boolean;
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
  if (resolution.unavailable === true) {
    // Declaration-store OUTAGE (`resolveRegion` fail-closed marker): this is NOT
    // an ordinary no-region user — a member whose VERIFIED region requires risk
    // disclosures must not clear the gate while the store that names that region
    // is down.  Same fail-closed arm as the policy-store outage below: the
    // treasury/Knomosis chokepoints reject the financial action (503) on
    // `unavailable`, never a silent pass.
    return { required: true, unavailable: true, region: null, missing: [] };
  }
  if (resolution.region === null) return { required: false, region: null, missing: [] };
  const outcome = await deps.activePolicy(deps.policy, resolution.region);
  if (outcome.kind === 'store_unavailable') {
    // Policy-store OUTAGE: we cannot read whether this region requires disclosures,
    // so fail CLOSED — the create route rejects the financial action (503) rather
    // than let an intent that would consume per-user/per-room deposit allowance
    // through on an unread gate.  Distinct from a truly `missing`/`future_dated`/
    // `malformed` policy, which carries no disclosures (the shipped `required:
    // false`).  This mirrors `coarseVerdict`'s `store_unavailable` fail-closed arm.
    return { required: true, unavailable: true, region: resolution.region, missing: [] };
  }
  if (outcome.kind !== 'active' || outcome.policy.disclosure_refs.length === 0) {
    return { required: false, region: resolution.region, missing: [] };
  }
  const missing: DisclosureRef[] = [];
  for (const ref of outcome.policy.disclosure_refs) {
    let acknowledged = false;
    try {
      const published = await deps.disclosures.listForVersion(
        ref.id,
        resolution.region,
        ref.version,
      );
      // The ref names the locales the region's legal coverage MUST include, so
      // every one of them has to exist: a ref satisfied by whichever
      // localization happened to be published would clear the gate while the
      // text some members actually read was never written.  Missing any
      // required locale (or the version entirely) stays missing — fail-closed;
      // counsel publishes the rest.
      const locales = new Set(published.map((version) => version.locale));
      if (!ref.locales.every((required) => locales.has(required))) {
        missing.push(ref);
        continue;
      }
      // An INFORMATIONAL disclosure (no locale requires acknowledgment) is
      // published to be read, not signed: the client renders no acknowledge
      // button for it, so demanding an ack would strand the user behind a gate
      // with no way to clear it.
      if (!published.some((version) => version.requiresAcknowledgment)) continue;
      // Region-scoped, locale-agnostic: the member reads ONE localization, and
      // the ack is evidence for this region's disclosure — but an
      // acknowledgment given in ANOTHER region (same id + version, different
      // text) does not satisfy it.
      acknowledged = await deps.acks.has(userId, ref.id, ref.version, resolution.region);
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
  if (resolution.unavailable === true) {
    // A declaration-store outage is NOT "no region declared": telling the user
    // to declare a region they may well have verified sends them into a dead
    // end, and recording the ack against an unresolved region would misfile the
    // consent evidence.  Transient ⇒ 503, retry.
    return {
      ok: false,
      status: 503,
      code: 'region_unavailable',
      message: 'Your region could not be resolved right now — try again shortly.',
    };
  }
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

/** The user-facing list: the region's published disclosures + ack status.
 *  `unavailable: true` marks a region-resolution outage — the caller must
 *  surface it (503) rather than present the empty list as "nothing to read"
 *  while the gate on the financial chokepoints is failing closed. */
export async function listDisclosuresForUser(
  deps: DisclosureDeps,
  userId: string,
): Promise<{
  unavailable: boolean;
  disclosures: Array<DisclosureVersionRecord & { acknowledged: boolean }>;
}> {
  const resolution = await deps.resolveRegion(userId);
  if (resolution.unavailable === true) return { unavailable: true, disclosures: [] };
  if (resolution.region === null) return { unavailable: false, disclosures: [] };
  const versions = await deps.disclosures.listForRegion(resolution.region);
  const out: Array<DisclosureVersionRecord & { acknowledged: boolean }> = [];
  for (const version of versions) {
    let acknowledged = false;
    try {
      acknowledged = await deps.acks.has(
        userId,
        version.disclosureId,
        version.version,
        version.region,
      );
    } catch {
      acknowledged = false;
    }
    out.push({ ...version, acknowledged });
  }
  return { unavailable: false, disclosures: out };
}
