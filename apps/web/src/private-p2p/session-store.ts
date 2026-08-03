// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.3 — the persisted private-room SESSION: the local device's keys, MLS
// group state, epoch keys, and manifest for one room.  A private room is hosted
// only on members' devices, so this is what lets a room SURVIVE a reload (the
// envelopes live in the `envelopes` store; this holds everything needed to open +
// author them again).  CryptoKeys are stored as NON-EXTRACTABLE `CryptoKey`
// objects (IndexedDB structured-clones them; their raw bytes never serialize),
// mirroring the WS-C draft-key-at-rest pattern.
//
// Type-only import of `@licio/private-p2p` (erased — the crypto/protocol core
// stays out of the initial bundle; `check:private-p2p-split` forbids a value
// import).  `manifest` is stored opaquely (`unknown`) and re-validated by the
// room manager (which dynamic-imports the schema).

import type { PersistedSnapshotBase } from '@licio/private-p2p';
import { z } from 'zod';
import { openPrivateP2pDb, promisify, ROOM_SESSION_STORE, txDone } from './storage.js';

/** A structured-clone byte field: a `Uint8Array`, an `ArrayBuffer`, or a typed-array view. */
const bytesLikeSchema = z.custom<ArrayBufferView | ArrayBuffer>(
  (v) => v instanceof Uint8Array || v instanceof ArrayBuffer || ArrayBuffer.isView(v),
);
/** A non-extractable `CryptoKey` — validated only for PRESENCE (its internals never serialize). */
const cryptoKeySchema = z.custom<CryptoKey>((v) => typeof v === 'object' && v !== null);

/**
 * The READ-side validator for a persisted session (PRIV-WEB-SESSION-5).  Validates the structural
 * (non-CryptoKey) contract — ids, the epoch list, bootstrap devices, byte-field presence — so a
 * corrupt/foreign row is discarded rather than cast-asserted into the engine.  The opaque `manifest`
 * / `snapshotBase` are re-validated downstream by the manager; CryptoKeys are presence-checked only.
 */
const storedRoomSessionSchema = z
  .object({
    roomId: z.string().min(1),
    roomIdCommitment: bytesLikeSchema,
    memberId: z.string().min(1),
    deviceId: z.string().min(1),
    signingPrivateKey: cryptoKeySchema,
    signingPublicKey: z.string().min(1),
    hpkePrivateKey: cryptoKeySchema,
    hpkePublicKey: bytesLikeSchema,
    mlsGroupState: bytesLikeSchema,
    epochs: z.array(
      z.object({
        epoch: z.number().int().nonnegative(),
        roomEpochSecret: bytesLikeSchema,
        contentWrapKey: bytesLikeSchema,
      }),
    ),
    manifest: z.unknown(),
    manifestCommitment: bytesLikeSchema,
    snapshotBase: z.unknown().optional(),
    bootstrapDevices: z.array(
      z.object({ deviceId: z.string().min(1), signingPublicKey: z.string().min(1) }),
    ),
    createdAtBucket: z.string().min(1),
    // Validated rather than passed through: the bootstrap capability inside it
    // is what a joined device resolves the directory record with, so a
    // half-written record must be discarded, not carried as a partial handle.
    directoryStub: z
      .object({
        capability: z.object({
          roomServerId: z.string().min(1),
          bootstrapBlindId: z.string().min(1),
        }),
      })
      .optional(),
  })
  .passthrough();

/** Validate (discard on failure) + normalize a row read from IndexedDB. */
function readStoredSession(raw: unknown): StoredRoomSession | undefined {
  if (!storedRoomSessionSchema.safeParse(raw).success) return undefined;
  try {
    return normalizeSession(raw as StoredRoomSession);
  } catch {
    return undefined; // a byte field that is not byte-shaped after all
  }
}

/**
 * Normalize a stored value back to a same-realm `Uint8Array`.  A structured-clone
 * round-trip (IndexedDB) can hand back bytes as an `ArrayBuffer`, a cross-realm
 * view, or a `Uint8Array`; downstream canonical encoding requires a true
 * current-realm `Uint8Array`, so we copy/wrap defensively at the read boundary.
 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('session-store: expected bytes');
}

/** Re-hydrate a session read from IndexedDB so every byte field is a real
 *  `Uint8Array` (CryptoKeys + the opaque manifest pass through untouched). */
function normalizeSession(raw: StoredRoomSession): StoredRoomSession {
  return {
    ...raw,
    roomIdCommitment: toBytes(raw.roomIdCommitment),
    hpkePublicKey: toBytes(raw.hpkePublicKey),
    mlsGroupState: toBytes(raw.mlsGroupState),
    manifestCommitment: toBytes(raw.manifestCommitment),
    epochs: raw.epochs.map((entry) => ({
      epoch: entry.epoch,
      roomEpochSecret: toBytes(entry.roomEpochSecret),
      contentWrapKey: toBytes(entry.contentWrapKey),
    })),
    // The §14.5 base is the SEALED snapshot (all base64-string + number fields), so
    // there is no Uint8Array field to reconstruct after a structured-clone round
    // trip — it is carried through verbatim by the `...raw` spread above.
  };
}

/**
 * The §21 directory handle a room holds locally.
 *
 * ONLY the capability — the thing any member needs to resolve the record, and
 * the thing a join grant and an invite carry.
 *
 * It deliberately carries no notion of OWNERSHIP. Two proxies for that were
 * tried and both were wrong: the room's admin role (the endpoints authorize by
 * ACCOUNT, so a non-founder room admin got controls that 403 and a creator who
 * lost the role lost controls they still had), and a persisted
 * "registered on this device" flag (a device outlives a session, so the next
 * account to sign in here inherited it, while the owner on a second device did
 * not). Ownership is the server's answer to give — `GET /v1/private-rooms/mine`
 * — and a local record cannot hold it without going stale.
 */
export interface StoredDirectoryStub {
  readonly capability: {
    /** The server-minted handle every §21 call takes. */
    readonly roomServerId: string;
    /** The §21.2 token that opens the record. Epoch-0 derived, never rotates. */
    readonly bootstrapBlindId: string;
  };
  /**
   * Set when the record this handle opens FAILED to verify against this room.
   *
   * A handle arrives in a sealed invite, and neither it nor the capability is
   * bound to the room the invite is for — so an inviter who belongs to room A
   * can put A's handle into an invite for room B. After joining B, the panel
   * checks the record against B's own key and commitment; when that fails, the
   * handle is not merely unusable, it is a pointer at ANOTHER room, and a member
   * who later becomes an admin would copy it into every invite they issue.
   *
   * Quarantined rather than deleted: the member should be told what happened and
   * decide, and a silent deletion is indistinguishable from never having had
   * one. Nothing propagates it while this is set.
   */
  readonly quarantined?: boolean;
}

/*
 * TWO fields, and the two that were dropped are worth naming.
 *
 * `stubId` had no consumer: every §21 endpoint is keyed by `room_server_id`.
 * `directoryMode` had one and it was WRONG — a delist changes the mode on the
 * server, so a copy stored at registration is stale from the first delist
 * onward. The panel reads the live mode from the bootstrap record it fetches
 * anyway, which is the only place the answer is true.
 *
 * Both mattered because this record now arrives through an INVITE, which knows
 * neither: it carries the room's stub reference and its capability, and would
 * have had to invent the other two.
 */

/** One persisted epoch's key material (mirrors the engine's `HeldEpochKeys`). */
export interface StoredEpochKeys {
  readonly epoch: number;
  readonly roomEpochSecret: Uint8Array;
  readonly contentWrapKey: Uint8Array;
}

/** The full persisted session for a room the local device belongs to. */
export interface StoredRoomSession {
  readonly roomId: string;
  readonly roomIdCommitment: Uint8Array;
  readonly memberId: string;
  readonly deviceId: string;
  /** The Ed25519 device signing key (non-extractable; signs authored ops). */
  readonly signingPrivateKey: CryptoKey;
  readonly signingPublicKey: string;
  /** The X25519 HPKE invite key (non-extractable; opens sealed invites). */
  readonly hpkePrivateKey: CryptoKey;
  readonly hpkePublicKey: Uint8Array;
  /** The serialized MLS group state (drives membership changes after reload). */
  readonly mlsGroupState: Uint8Array;
  /** Every epoch's keys the device holds (history is retained — §14.5). */
  readonly epochs: readonly StoredEpochKeys[];
  /** The §13.1 room manifest (opaque here; re-validated by the manager). */
  readonly manifest: unknown;
  readonly manifestCommitment: Uint8Array;
  /** The §14.5 compaction base (if the room has been compacted): the engine
   *  resumes from it and only the post-snapshot envelopes are re-verified. */
  readonly snapshotBase?: PersistedSnapshotBase;
  /** The genesis bootstrap devices (verify the founder self-add on load). */
  readonly bootstrapDevices: ReadonlyArray<{ deviceId: string; signingPublicKey: string }>;
  /** A coarse creation bucket for the room list (never an exact timestamp). */
  readonly createdAtBucket: string;
  /**
   * The §21 directory record this room registered, when it registered one.
   *
   * Persisted because the server-minted `room_server_id` is the ONLY handle for
   * every later bootstrap, patch, delist and delete — and there is no endpoint
   * that lists an account's stubs, so discarding it at creation would leave the
   * record unreachable and unmanageable forever. Absent ⇒ a `detached` room, or
   * one whose registration did not succeed.
   *
   * `bootstrapBlindId` is stored, not re-derived. It comes from the room's
   * EPOCH-0 rendezvous key (§21.2 — it must not rotate, or every outstanding
   * invite would break at the next membership change), and a device admitted at
   * epoch N never holds epoch 0. Only a stored copy can be handed on through a
   * join grant, so this is the field that makes the directory record reachable
   * by anyone other than the founder.
   */
  readonly directoryStub?: StoredDirectoryStub;
}

/** Persist (insert or replace) a room session. */
export async function putRoomSession(session: StoredRoomSession): Promise<void> {
  const db = await openPrivateP2pDb();
  try {
    const tx = db.transaction(ROOM_SESSION_STORE, 'readwrite');
    tx.objectStore(ROOM_SESSION_STORE).put(session);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** Read a room session by id (or `undefined` if the device has no such room). */
export async function getRoomSession(roomId: string): Promise<StoredRoomSession | undefined> {
  const db = await openPrivateP2pDb();
  try {
    const tx = db.transaction(ROOM_SESSION_STORE, 'readonly');
    const row = await promisify(tx.objectStore(ROOM_SESSION_STORE).get(roomId));
    return row === undefined ? undefined : readStoredSession(row);
  } finally {
    db.close();
  }
}

/** All room sessions on this device (for a room-list surface). */
export async function listRoomSessions(): Promise<StoredRoomSession[]> {
  const db = await openPrivateP2pDb();
  try {
    const tx = db.transaction(ROOM_SESSION_STORE, 'readonly');
    const rows = (await promisify(tx.objectStore(ROOM_SESSION_STORE).getAll())) as unknown[];
    // Validate + normalize each row (PRIV-WEB-SESSION-5): a malformed/foreign row is DISCARDED rather
    // than cast-asserted, and byte fields are re-hydrated to real `Uint8Array`s.
    return rows.map(readStoredSession).filter((s): s is StoredRoomSession => s !== undefined);
  } finally {
    db.close();
  }
}

/** Delete a room session (leaving/forgetting a room). */
export async function deleteRoomSession(roomId: string): Promise<void> {
  const db = await openPrivateP2pDb();
  try {
    const tx = db.transaction(ROOM_SESSION_STORE, 'readwrite');
    tx.objectStore(ROOM_SESSION_STORE).delete(roomId);
    await txDone(tx);
  } finally {
    db.close();
  }
}
