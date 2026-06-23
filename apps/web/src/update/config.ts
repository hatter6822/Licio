// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a/b — the update-channel client config: the trusted maintainer signer
// set + the transparency-log public key the private-mode bundle is verified
// against (PRIVATE_SPEC §20.6, §22.4).  These are PUBLIC keys only — no secret
// ever reaches the client (NO secrets in the client bundle, CLAUDE.md).  They
// arrive as `VITE_`-prefixed build-time env (the only env that reaches the
// client) so a release pins the signers/log it expects; a build with no signer
// set FAILS CLOSED (an empty set ⇒ every manifest is `signature_invalid` ⇒ rooms
// lock), never silently trusting an unverified bundle.
//
// Post-incident key rotation (§27.5): a release ships a ROTATED signer set
// (a replacement or superset of public keys).  Because trust is "the manifest's
// signer is in THIS set", rotating the set immediately distrusts a compromised
// key — and a manifest re-signed by a rotated key verifies under the new build.
// `withRotatedSigners` lets a recovered client verify against an explicitly
// rotated set without rebuilding.

/** The stable id of the protected artifact (the lazily code-split private chunk). */
export const PRIVATE_BUNDLE_ARTIFACT_ID = 'private-p2p';

/** Where the signed update manifest for the running release is served. */
export const UPDATE_MANIFEST_PATH = '/update-manifest.json';

/** Parse a comma/whitespace-separated list of base64url keys from env. */
function parseKeyList(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The verifier inputs the running app supplies (signer set + log key + floor). */
export interface UpdateChannelConfig {
  /** Raw Ed25519 maintainer release public keys (base64url) accepted as signers. */
  readonly trustedSignerPublicKeys: readonly string[];
  /** Raw Ed25519 transparency-log public key (base64url). */
  readonly logPublicKey: string;
  /** Highest release sequence the client has previously trusted (anti-rollback);
   *  `undefined` on first run. */
  readonly lastTrustedSequence?: number;
}

/**
 * Read the build-pinned signer set + log key from `VITE_` env.  Returns a config
 * with whatever was pinned; an EMPTY signer set or a missing log key is NOT an
 * error here — it is a fail-closed posture the verifier turns into a lock
 * (`signature_invalid` / `not_in_transparency_log`).
 */
export function loadUpdateChannelConfig(): UpdateChannelConfig {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    trustedSignerPublicKeys: parseKeyList(env['VITE_PRIVATE_BUNDLE_SIGNER_KEYS']),
    logPublicKey: env['VITE_PRIVATE_BUNDLE_LOG_KEY']?.trim() ?? '',
  };
}

/**
 * Produce a config whose trusted signer set is the explicitly ROTATED set
 * (post-incident, §27.5).  The rotated set REPLACES the build-pinned set for
 * this verification — a compromised key omitted from `rotatedSignerKeys` is no
 * longer trusted; new keys are added.  The log key + sequence floor are
 * preserved unless overridden.
 */
export function withRotatedSigners(
  base: UpdateChannelConfig,
  rotatedSignerKeys: readonly string[],
  options: { readonly lastTrustedSequence?: number } = {},
): UpdateChannelConfig {
  return {
    trustedSignerPublicKeys: rotatedSignerKeys.filter((k) => k.length > 0),
    logPublicKey: base.logPublicKey,
    ...(options.lastTrustedSequence !== undefined
      ? { lastTrustedSequence: options.lastTrustedSequence }
      : base.lastTrustedSequence !== undefined
        ? { lastTrustedSequence: base.lastTrustedSequence }
        : {}),
  };
}
