// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.6b — the recovery kit + the §12.7 terminality rule (PRIVATE_SPEC §12.6,
// §12.7, §16.2).  A recovery kit is a PORTABLE, passphrase-bound encrypted export
// of a member's own `RoomKeyMaterial` that lets them re-derive access on a NEW
// device with NO platform involvement: `importRecoveryKit` is a pure function of
// `(kit, passphrase)` — it makes no network call, and there is no server-side
// "recover room" path (enforced by the `check:no-p2p-server-content` umbrella).
//
// §12.7 terminality: if ALL member keys for a room are lost, the room is
// UNRECOVERABLE — the recovery kit is the only path, it is member-held and
// passphrase/hardware-bound, and the platform never holds it.  The
// creation-flow copy (`keys_lost_permanent` / `cannot_recover`, the WS-S.0.3
// SSOT in `@licio/shared`) must say so; this module never implies otherwise.
//
// A recovery kit reuses the tier-1 Argon2id wrap, but with a DISTINCT schema +
// domain tag and STRONGER cost parameters (the kit protects everything and is
// imported rarely), so it can never be confused with an at-rest key record.

import { z } from 'zod';
import { canonical, decodeCanonical } from './canonical.js';
import {
  type Argon2idParams,
  deriveArgon2idWrapKey,
  deserializeRoomKeyMaterial,
  KeyStoreError,
  type RoomKeyMaterial,
  serializeRoomKeyMaterial,
} from './key-store.js';
import { canonicalizeRecord } from './record-encoding.js';
import { fromBase64Url, getSubtle, randomBytes, toBase64Url, toBufferSource } from './runtime.js';

/** Stronger Argon2id params for the recovery kit (m = 64 MiB, t = 3) — it guards
 *  everything and is imported infrequently, so a higher cost is justified. */
export const RECOVERY_ARGON2ID_PARAMS: Argon2idParams = { t: 3, m: 65_536, p: 1 };

const RECOVERY_AAD_TAG = 'licio-priv1.recovery';
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const base64Url = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/);

/** The portable, passphrase-bound recovery kit (a self-describing artifact). */
export const recoveryKitSchema = z
  .object({
    schema: z.literal('licio.private.recovery_kit.v1'),
    roomId: z.string().min(1).max(128),
    kdf: z
      .object({
        salt: base64Url,
        t: z.number().int().min(1),
        m: z.number().int().min(8),
        p: z.number().int().min(1),
      })
      .strict(),
    nonce: base64Url,
    ciphertext: base64Url,
  })
  .strict();
export type RecoveryKit = z.infer<typeof recoveryKitSchema>;

function recoveryAad(roomId: string): Uint8Array {
  return canonical([RECOVERY_AAD_TAG, roomId]);
}

/**
 * Create a recovery kit: an Argon2id-passphrase-wrapped, portable export of the
 * member's `RoomKeyMaterial`.  The kit is NEVER stored server-side — the member
 * saves it offline (write-down, password manager, hardware token).
 */
export async function createRecoveryKit(
  material: RoomKeyMaterial,
  passphrase: string,
  params: Argon2idParams = RECOVERY_ARGON2ID_PARAMS,
): Promise<RecoveryKit> {
  const salt = randomBytes(SALT_LENGTH);
  const wrapKey = await deriveArgon2idWrapKey(passphrase, salt, params, 'encrypt');
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = new Uint8Array(
    await getSubtle().encrypt(
      {
        name: 'AES-GCM',
        iv: toBufferSource(nonce),
        additionalData: toBufferSource(recoveryAad(material.roomId)),
      },
      wrapKey,
      toBufferSource(serializeRoomKeyMaterial(material)),
    ),
  );
  return {
    schema: 'licio.private.recovery_kit.v1',
    roomId: material.roomId,
    kdf: { salt: toBase64Url(salt), t: params.t, m: params.m, p: params.p },
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
  };
}

/**
 * Import a recovery kit onto a new device, returning the member's
 * `RoomKeyMaterial`.  PURE: no server call, no platform involvement (§12.7).
 * Fails closed on the wrong passphrase or a tampered kit.
 */
export async function importRecoveryKit(
  kit: RecoveryKit,
  passphrase: string,
): Promise<RoomKeyMaterial> {
  const wrapKey = await deriveArgon2idWrapKey(
    passphrase,
    fromBase64Url(kit.kdf.salt),
    { t: kit.kdf.t, m: kit.kdf.m, p: kit.kdf.p },
    'decrypt',
  );
  let blob: Uint8Array;
  try {
    blob = new Uint8Array(
      await getSubtle().decrypt(
        {
          name: 'AES-GCM',
          iv: toBufferSource(fromBase64Url(kit.nonce)),
          additionalData: toBufferSource(recoveryAad(kit.roomId)),
        },
        wrapKey,
        toBufferSource(fromBase64Url(kit.ciphertext)),
      ),
    );
  } catch {
    throw new KeyStoreError('unlock_failed', 'recovery-kit AEAD open failed');
  }
  return deserializeRoomKeyMaterial(blob, kit.roomId);
}

/** Encode a recovery kit to a portable base64url text blob (for offline backup). */
export function encodeRecoveryKit(kit: RecoveryKit): string {
  return toBase64Url(canonicalizeRecord(kit));
}

/** Decode + validate a portable recovery-kit blob (the trust boundary). */
export function decodeRecoveryKit(text: string): RecoveryKit {
  let decoded: unknown;
  try {
    decoded = decodeCanonical(fromBase64Url(text));
  } catch {
    throw new KeyStoreError('invalid_record', 'recovery kit is not a canonical blob');
  }
  const parsed = recoveryKitSchema.safeParse(decoded);
  if (!parsed.success) throw new KeyStoreError('invalid_record', 'recovery kit failed validation');
  return parsed.data;
}
