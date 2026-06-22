// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.2 — the §10.3 invite + §12.3 join orchestration.  An admin mints an
// `InviteSecret` (HPKE-sealed to the invitee by `sealInvite`, delivered in a URL
// FRAGMENT so the server never sees it); the invitee opens it and builds a
// `JoinRequest` that PROVES knowledge of the invite secret (an HMAC over the
// request transcript) and carries a blind invite id (so a relay can never link
// the request to a room) plus its MLS KeyPackage.  The admin verifies the proof,
// then admits the device with `inviteDevice` (the MLS Add).  Pure + node-testable
// — the only "network" is delivering opaque blobs the caller transports.

import type { z } from 'zod';
import { canonical } from '../crypto/canonical.js';
import { decodeKeyPackage, encodeKeyPackage, type KeyPackage } from '../crypto/mls.js';
import {
  fromBase64Url,
  hmacSha256,
  randomBytes,
  timingSafeEqual,
  toBase64Url,
  tryFromBase64Url,
  utf8,
} from '../crypto/runtime.js';
import {
  type InviteSecret,
  type invitedRoleSchema,
  inviteSecretSchema,
  type JoinRequest,
  joinRequestSchema,
} from '../schemas/invite.js';

/** The HMAC domain labels (pinned so the blind/proof derivations cannot drift). */
const INVITE_ID_BLIND_LABEL = 'licio.private.invite-id-blind.v1';
const JOIN_PROOF_LABEL = 'licio.private.join-proof.v1';

/** Derive the §12.3 blind invite id — `HMAC(invite_secret, label || invite_id)`.
 *  A relay sees only this; without `invite_secret` it cannot recover `invite_id`
 *  or link the request to a room. */
export async function deriveInviteIdBlind(
  inviteSecret: Uint8Array,
  inviteId: string,
): Promise<string> {
  return toBase64Url(await hmacSha256(inviteSecret, utf8(`${INVITE_ID_BLIND_LABEL}:${inviteId}`)));
}

/** Derive the §12.3 proof-of-invite-secret — an HMAC bound to the SPECIFIC join
 *  request (the offered KeyPackage + the coarse time), so the proof cannot be
 *  replayed with a different device key. */
export async function deriveJoinProof(
  inviteSecret: Uint8Array,
  recipientKeyPackageB64: string,
  requestedAtBucket: string,
): Promise<string> {
  const transcript = canonical([JOIN_PROOF_LABEL, recipientKeyPackageB64, requestedAtBucket]);
  return toBase64Url(await hmacSha256(inviteSecret, transcript));
}

/** Parameters for `createRoomInvite`. */
export interface CreateRoomInviteParams {
  /** The room's §10.3 invite public key (HPKE), from `createPrivateRoom`. */
  readonly roomPublicKey: string;
  readonly grantedRole: z.infer<typeof invitedRoleSchema>;
  /** ISO expiry (the verifier rejects an invite at/after this instant). */
  readonly expiresAt: string;
  readonly maxUses?: number;
  readonly requiresAdminApproval?: boolean;
  readonly roomStubRef?: string;
  /** The invite id (default: a fresh random id). */
  readonly inviteId?: string;
  /** The raw invite secret (default: 32 fresh random bytes). */
  readonly inviteSecret?: Uint8Array;
}

/**
 * Mint a §10.3 `InviteSecret` (the admin then `sealInvite`s it to the invitee).
 * The `invite_secret` is the shared key the §12.3 blind id + proof derive from.
 */
export function createRoomInvite(params: CreateRoomInviteParams): InviteSecret {
  const inviteSecret = params.inviteSecret ?? randomBytes(32);
  return inviteSecretSchema.parse({
    schema: 'licio.private.invite_secret.v1',
    room_public_key: params.roomPublicKey,
    invite_id: params.inviteId ?? toBase64Url(randomBytes(16)),
    invite_secret: toBase64Url(inviteSecret),
    expires_at: params.expiresAt,
    max_uses: params.maxUses ?? 1,
    granted_role: params.grantedRole,
    requires_admin_approval: params.requiresAdminApproval ?? false,
    ...(params.roomStubRef === undefined ? {} : { room_stub_ref: params.roomStubRef }),
  } satisfies InviteSecret);
}

/** Parameters for `buildJoinRequest` (the invitee side). */
export interface BuildJoinRequestParams {
  /** The opened invite. */
  readonly invite: InviteSecret;
  /** The invitee's MLS KeyPackage (public package) the Add commit will admit. */
  readonly keyPackage: KeyPackage;
  readonly proposedDisplayName: string;
  /** A COARSE time bucket (never an exact timestamp). */
  readonly requestedAtBucket: string;
}

/**
 * Build a §12.3 `JoinRequest`: blind the invite id, encode the KeyPackage, and
 * prove knowledge of `invite_secret` over the request transcript.
 */
export async function buildJoinRequest(params: BuildJoinRequestParams): Promise<JoinRequest> {
  const secret = fromBase64Url(params.invite.invite_secret);
  const keyPackageB64 = toBase64Url(encodeKeyPackage(params.keyPackage));
  return joinRequestSchema.parse({
    schema: 'licio.private.join_request.v1',
    invite_id_blind: await deriveInviteIdBlind(secret, params.invite.invite_id),
    recipient_device_key_package: keyPackageB64,
    proposed_display_name: params.proposedDisplayName,
    proof_of_invite_secret: await deriveJoinProof(secret, keyPackageB64, params.requestedAtBucket),
    requested_at_bucket: params.requestedAtBucket,
  } satisfies JoinRequest);
}

/** The verdict of `verifyJoinRequest`. */
export type JoinRequestVerdict =
  | {
      readonly ok: true;
      readonly keyPackage: KeyPackage;
      readonly grantedRole: InviteSecret['granted_role'];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'expired'
        | 'exhausted'
        | 'invite_id_mismatch'
        | 'proof_invalid'
        | 'malformed_key_package';
    };

/** Options for `verifyJoinRequest`. */
export interface VerifyJoinRequestOptions {
  readonly now: Date;
  /** Accepted joins already charged against this invite (enforces `max_uses`). */
  readonly usesSoFar?: number;
}

/**
 * Verify a §12.3 `JoinRequest` against the invite (admin side): expiry, the
 * `max_uses` budget, the blind invite id, and the proof-of-invite-secret (all
 * constant-time), then decode the offered KeyPackage.  On success the admin
 * passes `keyPackage` to `inviteDevice` (the MLS Add).
 */
export async function verifyJoinRequest(
  invite: InviteSecret,
  request: JoinRequest,
  options: VerifyJoinRequestOptions,
): Promise<JoinRequestVerdict> {
  // Fail closed on a non-finite expiry: a malformed `expires_at` string parses to
  // NaN, and `NaN <= now` is false — without this an unparseable expiry would be
  // treated as never-expiring (verifiable until `max_uses` is exhausted).
  const expiresAtMs = new Date(invite.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= options.now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if ((options.usesSoFar ?? 0) >= invite.max_uses) {
    return { ok: false, reason: 'exhausted' };
  }
  // Decode the wire-supplied (joiner) base64 fields fail-closed: a malformed-but-
  // regex-passing value must yield a typed verdict, not throw mid-verification.
  const requestBlind = tryFromBase64Url(request.invite_id_blind);
  if (!requestBlind) return { ok: false, reason: 'invite_id_mismatch' };
  const requestProof = tryFromBase64Url(request.proof_of_invite_secret);
  if (!requestProof) return { ok: false, reason: 'proof_invalid' };
  const secret = fromBase64Url(invite.invite_secret);
  const expectedBlind = await deriveInviteIdBlind(secret, invite.invite_id);
  if (!timingSafeEqual(requestBlind, fromBase64Url(expectedBlind))) {
    return { ok: false, reason: 'invite_id_mismatch' };
  }
  const expectedProof = await deriveJoinProof(
    secret,
    request.recipient_device_key_package,
    request.requested_at_bucket,
  );
  if (!timingSafeEqual(requestProof, fromBase64Url(expectedProof))) {
    return { ok: false, reason: 'proof_invalid' };
  }
  let keyPackage: KeyPackage;
  try {
    keyPackage = decodeKeyPackage(fromBase64Url(request.recipient_device_key_package));
  } catch {
    return { ok: false, reason: 'malformed_key_package' };
  }
  return { ok: true, keyPackage, grantedRole: invite.granted_role };
}
