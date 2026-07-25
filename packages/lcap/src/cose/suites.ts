// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Algorithm agility + downgrade protection (OFFLINE_SPEC §10.3, §10.4).  Every
// proof identifies its algorithm in the signed protected header; suite
// resolution is centralized here and FAILS CLOSED on an unknown or disabled
// algorithm.  A node that supports a stronger suite MUST NOT accept a weaker or
// disabled one merely because a peer advertised fewer suites — so negotiation
// always selects the highest-preference *enabled* suite and never silently
// downgrades.

/** Negotiable signature suites (§4.1).  Ed25519 is reserved but DISABLED in v0.2. */
export type CryptoSuiteId = 'ES256' | 'Ed25519';

export interface SuiteDescriptor {
  readonly id: CryptoSuiteId;
  /** The COSE algorithm label carried in the protected header (§10.2.1). */
  readonly coseAlg: number;
  readonly enabled: boolean;
  /** Raw signature length in bytes (r||s for ES256). */
  readonly signatureLength: number;
}

const SUITES: Readonly<Record<CryptoSuiteId, SuiteDescriptor>> = {
  ES256: { id: 'ES256', coseAlg: -7, enabled: true, signatureLength: 64 },
  // Reserved for a future suite once browser support / audit posture allow it
  // (§10.3).  Disabled, so any EdDSA proof fails closed today.
  Ed25519: { id: 'Ed25519', coseAlg: -8, enabled: false, signatureLength: 64 },
};

const ALG_TO_SUITE: ReadonlyMap<number, CryptoSuiteId> = new Map(
  (Object.keys(SUITES) as CryptoSuiteId[]).map((id) => [SUITES[id].coseAlg, id]),
);

/**
 * Reserved COSE algorithm label for a future classical+post-quantum hybrid
 * proof over the SAME `record_cid` (§10.4).  It is parked here (disabled) so the
 * identifier space is claimed; enabling it later adds a second proof over an
 * unchanged record body and therefore does not alter record identity.
 */
export const RESERVED_HYBRID_ALG = -65537;

export type SuiteFailure = 'unknown_alg' | 'disabled_suite' | 'no_common_suite';
export type SuiteResolution =
  | { readonly ok: true; readonly suite: SuiteDescriptor }
  | { readonly ok: false; readonly reason: SuiteFailure };

/**
 * Resolve a suite from a COSE algorithm label, failing closed: an unrecognized
 * label is `unknown_alg`; a recognized-but-disabled suite (e.g. Ed25519 in
 * v0.2) is `disabled_suite`.  Neither is ever treated as a valid signature.
 */
export function resolveSuiteByAlg(coseAlg: number): SuiteResolution {
  const id = ALG_TO_SUITE.get(coseAlg);
  if (!id) return { ok: false, reason: 'unknown_alg' };
  const suite = SUITES[id];
  if (!suite.enabled) return { ok: false, reason: 'disabled_suite' };
  return { ok: true, suite };
}

export function isSuiteEnabled(id: CryptoSuiteId): boolean {
  return SUITES[id].enabled;
}

/** Strongest-first preference order used for downgrade-resistant negotiation. */
const PREFERENCE: readonly CryptoSuiteId[] = ['Ed25519', 'ES256'];

/**
 * Choose the strongest mutually-supported ENABLED suite.  Because we iterate in
 * fixed preference order and skip disabled suites, an attacker who strips the
 * stronger suite from `peerSuites` cannot force a downgrade below our enabled
 * floor; if there is no common enabled suite the result fails closed.
 */
export function negotiateSuite(peerSuites: readonly CryptoSuiteId[]): SuiteResolution {
  for (const id of PREFERENCE) {
    if (SUITES[id].enabled && peerSuites.includes(id)) {
      return { ok: true, suite: SUITES[id] };
    }
  }
  return { ok: false, reason: 'no_common_suite' };
}
