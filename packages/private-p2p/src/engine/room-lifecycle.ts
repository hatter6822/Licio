// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.1 — the room-creation + membership orchestration.  This module ties the
// §10.2 MLS group keying, the §10.2 epoch→five-key bridge, the §13.1 room
// manifest, and the §12.1 founder genesis op into ONE node-testable surface, so a
// creation-wizard UI (or a test) calls `createPrivateRoom` and hands the result
// to `PrivateRoomEngine.load` + `applyLocalOp` — no UI/transport required to
// found a room.  Every value is REAL crypto: a real Ed25519 device key, a real
// X25519 HPKE invite key, and a real serialized MLS KeyPackage (never a
// placeholder), so an inviter/joiner can later decode the founder's package and
// admit further devices.
//
// Pure orchestration over the crypto + schema layers; the caller owns I/O
// (persisting the MLS group, the device keys, and the engine's storage).

import type { z } from 'zod';
import { type CanonicalValue, canonical } from '../crypto/canonical.js';
import { deriveAuthorDeviceIdBlind } from '../crypto/device-blind.js';
import { deriveEpochState, type RoomEpochState } from '../crypto/epoch.js';
import { generateRecipientKeyPair, type HpkeRecipientKeyPair } from '../crypto/hpke.js';
import {
  addMember,
  createGroup,
  encodeKeyPackage,
  findDeviceLeafIndex,
  generateMemberKeyPackage,
  type KeyPackage,
  type KeyPackageBundle,
  MLS_CIPHERSUITE_NAME,
  type MLSMessage,
  type MlsGroup,
  processWelcome,
  type RatchetTree,
  ratchetTree as ratchetTreeOf,
  removeMember,
  type Welcome,
} from '../crypto/mls.js';
import {
  type PrivateCryptoKeyPair,
  randomBytes,
  sha256,
  toBase64Url,
  utf8,
} from '../crypto/runtime.js';
import { exportPublicKeyRaw, generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import type { HeldEpochKeys } from '../reducer/intake-context.js';
import type { SealOpParams } from '../reducer/validate-op.js';
import type { privateRoleSchema } from '../schemas/common.js';
import {
  type PrivateRoomManifest,
  privateRoomManifestSchema,
  type privateRoomPolicySchema,
} from '../schemas/manifest.js';
import { type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';
import type { PrivateRoomEngineParams } from './room-engine.js';

/** The op-body INPUT type (pre-zod-defaults): a content op may omit fields the
 *  schema defaults (e.g. `citations`/`metadata`), which `buildRoomOp` parses in. */
export type PrivateOpBodyInput = z.input<typeof privateRoomOpSchema>['body'];

type PrivateRoomPolicy = z.infer<typeof privateRoomPolicySchema>;

/** The §4.1 P2P-room policy defaults (the maintainer-private posture: unlisted,
 *  admin-gated membership, all-members posting, relay-preferred transport). */
export const DEFAULT_PRIVATE_ROOM_POLICY: PrivateRoomPolicy = {
  directory_mode: 'unlisted',
  membership_change: 'admin',
  posting_policy: 'all_members',
  allow_member_invites: false,
  default_new_member_role: 'member',
  transport_mode: 'relay_preferred',
  replication_target: 3,
  small_op_padding: '16k',
  allow_blind_push: false,
};

/** Recursively map a JSON-ish value to a `CanonicalValue`, OMITTING `undefined`
 *  keys (so an absent optional manifest field never alters the commitment). */
function plainToCanonical(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('plainToCanonical: non-integer number');
    return value;
  }
  if (Array.isArray(value)) return value.map(plainToCanonical);
  if (typeof value === 'object') {
    const out: Record<string, CanonicalValue> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined) out[key] = plainToCanonical(val);
    }
    return out;
  }
  throw new Error('plainToCanonical: unsupported value');
}

/**
 * The §10.2 `manifest_commitment` bound into the epoch exporter context:
 * `SHA-256(canonical(manifest))` over the PLAINTEXT manifest.  Computed before
 * encryption (the keys depend on it), and deterministic — the founder and a
 * joiner holding the same manifest derive the identical commitment, so they
 * derive the identical epoch keys.
 */
export function computeManifestCommitment(manifest: PrivateRoomManifest): Promise<Uint8Array> {
  return sha256(canonical(plainToCanonical(manifest)));
}

/** The genesis/empty capability-log root (a commitment over the empty array) —
 *  the §10.5 `capability_root_at_seq` an op cites when no prior capability state
 *  exists. */
function emptyCapabilityRoot(): Promise<Uint8Array> {
  return sha256(canonical([]));
}

/** Assemble the §10.5 seal params to author an op under a given epoch. */
async function buildSealParams(
  epochState: RoomEpochState,
  roomIdCommitment: Uint8Array,
  deviceId: string,
  deviceSigningKey: CryptoKey,
  capabilityRootAtSeq: Uint8Array,
): Promise<SealOpParams> {
  return {
    roomIdCommitment,
    contentWrapKey: epochState.keys.contentWrapKey,
    deviceSigningKey,
    authorDeviceIdBlind: await deriveAuthorDeviceIdBlind(
      epochState.roomEpochSecret,
      roomIdCommitment,
      deviceId,
      Number(epochState.epoch),
    ),
    capabilityRootAtSeq,
  };
}

/** The `HeldEpochKeys` (secret + content-wrap key) extracted from a full epoch
 *  state — what the engine's `epochs` map and `addEpochKeys` consume. */
export function heldKeysOf(epochState: RoomEpochState): HeldEpochKeys {
  return {
    roomEpochSecret: epochState.roomEpochSecret,
    contentWrapKey: epochState.keys.contentWrapKey,
  };
}

/** Parameters for `createPrivateRoom`. */
export interface CreatePrivateRoomParams {
  readonly roomId: string;
  readonly founderMemberId: string;
  readonly founderDeviceId: string;
  /** The §13.1 room profile (name/description/room_type). */
  readonly profile: PrivateRoomManifest['profile'];
  /** Policy overrides merged over `DEFAULT_PRIVATE_ROOM_POLICY`. */
  readonly policy?: Partial<PrivateRoomPolicy>;
  /** The room identity commitment (default: 32 random bytes). */
  readonly roomIdCommitment?: Uint8Array;
  /** The MLS group id (default: 32 random bytes). */
  readonly mlsGroupId?: Uint8Array;
  /** The genesis creation timestamp (ISO; default: now). */
  readonly createdAt?: string;
}

/** The founder's secrets + the artefacts to construct the engine + author genesis. */
export interface CreatedPrivateRoom {
  readonly roomId: string;
  readonly roomIdCommitment: Uint8Array;
  readonly mlsGroupId: Uint8Array;
  /** The plaintext manifest (encrypt + content-address it for sharing). */
  readonly manifest: PrivateRoomManifest;
  readonly manifestCommitment: Uint8Array;
  /** The founder's MLS group handle (persist via `serializeGroupState`). */
  readonly group: MlsGroup;
  /** Epoch-0 secret + five keys. */
  readonly epochState: RoomEpochState;
  readonly founder: {
    readonly memberId: string;
    readonly deviceId: string;
    /** The Ed25519 device signing key pair (persist the private key in the key store). */
    readonly signingKeyPair: PrivateCryptoKeyPair;
    /** The X25519 HPKE invite key pair (invitees seal the room secret to the public key). */
    readonly hpkeKeyPair: HpkeRecipientKeyPair;
    /** The founder's MLS key package bundle (the public package is in the genesis op). */
    readonly mlsKeyPackage: KeyPackageBundle;
  };
  /** The unsealed §12.1 genesis op (founder self-add); seal + ingest with `sealParams`. */
  readonly genesisOp: PrivateRoomOp;
  readonly sealParams: SealOpParams;
  /** Engine construction params (minus `storage` — the caller supplies it). */
  readonly engineParams: Omit<PrivateRoomEngineParams, 'storage'>;
}

/**
 * Found a new private room: generate the founder's keys, create the MLS group,
 * derive epoch-0 keys (bound to the room manifest), and assemble the genesis
 * `member.add` op (the founder's self-add at `admin`).  The caller then:
 *
 *   const created = await createPrivateRoom({ … });
 *   const engine = await PrivateRoomEngine.load({ ...created.engineParams, storage });
 *   await engine.applyLocalOp(created.genesisOp, created.sealParams);
 */
export async function createPrivateRoom(
  params: CreatePrivateRoomParams,
): Promise<CreatedPrivateRoom> {
  const roomIdCommitment = params.roomIdCommitment ?? randomBytes(32);
  const mlsGroupId = params.mlsGroupId ?? randomBytes(32);
  const createdAt = params.createdAt ?? new Date().toISOString();
  const policy: PrivateRoomPolicy = { ...DEFAULT_PRIVATE_ROOM_POLICY, ...params.policy };

  // 1) Founder keys: Ed25519 device signing key, X25519 HPKE invite key, MLS package.
  //    The signing PRIVATE key is non-extractable (§10.8) — its public key still
  //    exports + it still signs + it structured-clones into IndexedDB for the
  //    persisted session, so its raw bytes never leave WebCrypto.
  const signingKeyPair = await generateDeviceSigningKeyPair(false);
  const signingPublicKey = toBase64Url(await exportPublicKeyRaw(signingKeyPair.publicKey));
  const hpkeKeyPair = await generateRecipientKeyPair();
  const mlsKeyPackage = await generateMemberKeyPackage(utf8(params.founderDeviceId));

  // 2) The MLS group (the founder is the first member).
  const group = await createGroup(mlsGroupId, mlsKeyPackage);

  // 3) The §13.1 manifest, then its commitment, then epoch-0 keys bound to it.
  const emptyLogRoot = toBase64Url(await sha256(canonical([])));
  const manifest = privateRoomManifestSchema.parse({
    schema: 'licio.private.room_manifest.v1',
    room_id: params.roomId,
    created_at: createdAt,
    profile: params.profile,
    policy,
    crypto: {
      // The genesis room invite key: invitees seal the room secret to it (§10.3).
      room_public_key: toBase64Url(hpkeKeyPair.publicKey),
      mls_group_id: toBase64Url(mlsGroupId),
      current_epoch: 0,
      mls_cipher_suite: MLS_CIPHERSUITE_NAME,
      envelope_profile: 'licio-private-envelope-v1',
      cid_profile: 'licio-private-cid-v1',
    },
    roots: {
      membership_log_root: emptyLogRoot,
      capability_log_root: emptyLogRoot,
      operation_log_root: emptyLogRoot,
    },
  } satisfies PrivateRoomManifest);
  const manifestCommitment = await computeManifestCommitment(manifest);
  const epochState = await deriveEpochState(group, roomIdCommitment, manifestCommitment);

  // 4) The §12.1 genesis op: the founder self-adds as admin.
  const genesisOp = privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: params.roomId,
    epoch: Number(epochState.epoch),
    op_id: 'genesis',
    author_member_id: params.founderMemberId,
    author_device_id: params.founderDeviceId,
    author_seq: 0,
    created_at: createdAt,
    created_at_bucket: createdAt.slice(0, 13),
    lamport: '1',
    parents: [],
    body: {
      type: 'member.add',
      member_id: params.founderMemberId,
      device_id: params.founderDeviceId,
      signing_public_key: signingPublicKey,
      hpke_public_key: toBase64Url(hpkeKeyPair.publicKey),
      mls_key_package: toBase64Url(encodeKeyPackage(mlsKeyPackage.publicPackage)),
      granted_role: 'admin',
    },
  } satisfies PrivateRoomOp);

  // The genesis capability commitment = the empty-log root (no prior capability state).
  const sealParams = await buildSealParams(
    epochState,
    roomIdCommitment,
    params.founderDeviceId,
    signingKeyPair.privateKey,
    await emptyCapabilityRoot(),
  );

  const epochs = new Map<number, HeldEpochKeys>([
    [Number(epochState.epoch), heldKeysOf(epochState)],
  ]);

  return {
    roomId: params.roomId,
    roomIdCommitment,
    mlsGroupId,
    manifest,
    manifestCommitment,
    group,
    epochState,
    founder: {
      memberId: params.founderMemberId,
      deviceId: params.founderDeviceId,
      signingKeyPair,
      hpkeKeyPair,
      mlsKeyPackage,
    },
    genesisOp,
    sealParams,
    engineParams: {
      roomId: params.roomId,
      roomIdCommitment,
      epochs,
      bootstrapDevices: [{ deviceId: params.founderDeviceId, signingPublicKey }],
    },
  };
}

// --- Membership: invite a device + join from a Welcome (§10.2 / §12) ----------

/** The artefacts an admin produces when admitting a device (an MLS Add commit). */
export interface InvitedDevice {
  /** The inviter's NEW group handle (the epoch has advanced). */
  readonly group: MlsGroup;
  /** The commit to broadcast to existing members so they advance epoch. */
  readonly commit: MLSMessage;
  /** The Welcome to deliver to the joining device. */
  readonly welcome: Welcome;
  /** The ratchet tree the joiner needs to process the Welcome. */
  readonly ratchetTree: RatchetTree;
}

/**
 * Admit a device into the room's MLS group (§10.2 / §10.9): an MLS Add commit
 * that advances the epoch and yields the Welcome for the joiner.  The caller then
 * derives the new epoch state, authors the §12 `member.add` op (`buildMemberAddOp`),
 * and distributes the commit (existing members) + Welcome (joiner).
 */
export async function inviteDevice(
  group: MlsGroup,
  newDeviceKeyPackage: KeyPackage,
): Promise<InvitedDevice> {
  const outcome = await addMember(group, newDeviceKeyPackage);
  if (!outcome.welcome) throw new Error('inviteDevice: the MLS Add produced no Welcome');
  return {
    group: outcome.group,
    commit: outcome.commit,
    welcome: outcome.welcome,
    ratchetTree: ratchetTreeOf(outcome.group),
  };
}

/** The artefacts of removing a device (an MLS Remove commit → new epoch). */
export interface RemovedDevice {
  /** The post-Remove group handle (the epoch has advanced; the removed device
   *  cannot derive the new epoch's keys — forward secrecy). */
  readonly group: MlsGroup;
  /** The commit to broadcast to the REMAINING members so they advance epoch. */
  readonly commit: MLSMessage;
}

/**
 * Remove a device from the room's MLS group (§10.9): an MLS Remove commit that
 * advances the epoch, so the removed device can no longer derive the room keys.
 * The caller then derives the new epoch state, authors the §12 `member.remove` /
 * `device.remove` op (`buildRoomOp`), and broadcasts the commit to the remaining
 * members.  Throws if `deviceIdentity` is not a current group member.
 */
export async function removeDeviceFromRoom(
  group: MlsGroup,
  deviceIdentity: Uint8Array,
): Promise<RemovedDevice> {
  const leafIndex = findDeviceLeafIndex(group, deviceIdentity);
  if (leafIndex === undefined) {
    throw new Error('removeDeviceFromRoom: the device is not in the MLS group');
  }
  const outcome = await removeMember(group, leafIndex);
  return { group: outcome.group, commit: outcome.commit };
}

/** The result of joining from a Welcome: the group handle + the joined epoch's keys. */
export interface JoinedRoom {
  readonly group: MlsGroup;
  readonly epochState: RoomEpochState;
}

/**
 * Join a room from a Welcome (§10.2 / §12.3): process the Welcome into a group
 * handle, then derive the joined epoch's keys.  `manifestCommitment` must match
 * the room's manifest (received with the invite) so the joiner derives the SAME
 * epoch keys as every other device at that epoch — the convergence property.
 */
export async function joinRoom(params: {
  readonly welcome: Welcome;
  readonly bundle: KeyPackageBundle;
  readonly ratchetTree?: RatchetTree;
  readonly roomIdCommitment: Uint8Array;
  readonly manifestCommitment: Uint8Array;
}): Promise<JoinedRoom> {
  const group = await processWelcome(params.welcome, params.bundle, params.ratchetTree);
  const epochState = await deriveEpochState(
    group,
    params.roomIdCommitment,
    params.manifestCommitment,
  );
  return { group, epochState };
}

/** The author + causal metadata shared by every non-genesis op builder.  The
 *  causal fields (`parents` = current heads, `lamport`, `author.seq`) derive from
 *  the local DAG — the engine exposes `heads()`/`nextLamport()`/`nextAuthorSeq()`. */
export interface OpAuthoringBase {
  readonly roomId: string;
  readonly roomIdCommitment: Uint8Array;
  /** The epoch the op is authored + sealed under. */
  readonly epochState: RoomEpochState;
  readonly author: {
    readonly memberId: string;
    readonly deviceId: string;
    readonly signingKey: CryptoKey;
    readonly seq: number;
  };
  readonly opId: string;
  readonly parents: readonly string[];
  readonly lamport: string;
  readonly createdAt?: string;
  readonly capabilityRootAtSeq?: Uint8Array;
}

/**
 * Author ANY §13 room op (membership or content) from a `PrivateOpBody` + the
 * params to seal it under `epochState`.  This is the single op-authoring core
 * (`buildMemberAddOp` and content authoring both route through it); the reducer's
 * §11.3 capability check enforces whether the author may apply the op.
 */
export async function buildRoomOp(
  base: OpAuthoringBase,
  body: PrivateOpBodyInput,
): Promise<{ op: PrivateRoomOp; sealParams: SealOpParams }> {
  const createdAt = base.createdAt ?? new Date().toISOString();
  const op = privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: base.roomId,
    epoch: Number(base.epochState.epoch),
    op_id: base.opId,
    author_member_id: base.author.memberId,
    author_device_id: base.author.deviceId,
    author_seq: base.author.seq,
    created_at: createdAt,
    created_at_bucket: createdAt.slice(0, 13),
    lamport: base.lamport,
    parents: [...base.parents],
    body,
  } satisfies z.input<typeof privateRoomOpSchema>);
  const sealParams = await buildSealParams(
    base.epochState,
    base.roomIdCommitment,
    base.author.deviceId,
    base.author.signingKey,
    base.capabilityRootAtSeq ?? (await emptyCapabilityRoot()),
  );
  return { op, sealParams };
}

/** The device an admin admits (the §12 `member.add` body fields). */
export interface NewMemberDevice {
  readonly memberId: string;
  readonly deviceId: string;
  readonly signingPublicKey: string;
  readonly hpkePublicKey: string;
  /** base64url of `encodeKeyPackage(newDevice.publicPackage)`. */
  readonly mlsKeyPackage: string;
  readonly role: z.infer<typeof privateRoleSchema>;
}

/**
 * Author a §12 `member.add` op (an existing admin adds a device).  A thin wrapper
 * over `buildRoomOp` that assembles the member.add body.
 */
export function buildMemberAddOp(
  base: OpAuthoringBase,
  newMember: NewMemberDevice,
): Promise<{ op: PrivateRoomOp; sealParams: SealOpParams }> {
  return buildRoomOp(base, {
    type: 'member.add',
    member_id: newMember.memberId,
    device_id: newMember.deviceId,
    signing_public_key: newMember.signingPublicKey,
    hpke_public_key: newMember.hpkePublicKey,
    mls_key_package: newMember.mlsKeyPackage,
    granted_role: newMember.role,
  });
}
