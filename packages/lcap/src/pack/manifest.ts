// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundle manifest + MIME/magic registration (OFFLINE_SPEC §14.2, §14.8,
// WS-R.4.4).  A bundle manifest is a record body, NOT an authority statement: a
// manifest signature proves who PREPARED the bundle, not that the contained
// records are trusted (those still pass full `validate`, WS-R.8).  High-risk
// exports use a generic filename that reveals no room or topic.

import { buildAndSign, type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import { encodeWithSchema } from '../schemas/codec.js';
import { type BundleManifestRecordV2, bundleManifestRecordV2Schema } from '../schemas/pack.js';

/** The recommended `.licio-bundle` extension (§14.2). */
export const BUNDLE_EXTENSION = '.licio-bundle';
/** The recommended MIME type (§14.2). */
export const BUNDLE_MIME = 'application/vnd.licio.lcap-pack';

export interface ManifestBundle {
  readonly manifest: BundleManifestRecordV2;
  readonly body: Uint8Array;
  readonly proof: DetachedProofV2;
}

/** Build + sign a bundle manifest with the preparer's device key. */
export async function signManifest(params: {
  preparerPrivateKey: CryptoKey;
  preparerSignerKeyId: string;
  manifest: BundleManifestRecordV2;
  networkId: string;
}): Promise<ManifestBundle> {
  const body = encodeWithSchema(bundleManifestRecordV2Schema, params.manifest);
  const proof = await buildAndSign({
    privateKey: params.preparerPrivateKey,
    signerKeyId: params.preparerSignerKeyId,
    proofKind: 'device_signature',
    recordKind: 'bundle_manifest',
    recordBody: body,
    networkId: params.networkId,
  });
  return { manifest: params.manifest, body, proof };
}

export type ManifestVerification =
  | { readonly ok: true; readonly preparerKeyId: string }
  | { readonly ok: false };

/**
 * Verify a manifest's preparer signature.  This authenticates ONLY who prepared
 * the bundle — the contained records are NOT thereby trusted and must still pass
 * `validate` individually.
 */
export async function verifyManifest(
  bundle: ManifestBundle,
  preparerPublicKey: CryptoKey,
  ctx: { networkId: string },
): Promise<ManifestVerification> {
  const verified = await verifyDetached(bundle.proof, bundle.body, preparerPublicKey, {
    networkId: ctx.networkId,
    expectedRecordKind: 'bundle_manifest',
  });
  return verified.ok ? { ok: true, preparerKeyId: bundle.proof.signer_key_id } : { ok: false };
}

/**
 * A generic, room/topic-free filename for a high-risk export (§14.2/§33.5).  The
 * suffix is a caller-supplied opaque token (e.g. a timestamp or random id) that
 * MUST NOT encode a room or topic.
 */
export function genericBundleFilename(opaqueSuffix = 'bundle'): string {
  return `export-${opaqueSuffix}${BUNDLE_EXTENSION}`;
}
