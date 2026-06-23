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
import { openPrivateP2pDb, promisify, ROOM_SESSION_STORE, txDone } from './storage.js';

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
    const row = (await promisify(tx.objectStore(ROOM_SESSION_STORE).get(roomId))) as
      | StoredRoomSession
      | undefined;
    return row ? normalizeSession(row) : undefined;
  } finally {
    db.close();
  }
}

/** All room sessions on this device (for a room-list surface). */
export async function listRoomSessions(): Promise<StoredRoomSession[]> {
  const db = await openPrivateP2pDb();
  try {
    const tx = db.transaction(ROOM_SESSION_STORE, 'readonly');
    const rows = (await promisify(
      tx.objectStore(ROOM_SESSION_STORE).getAll(),
    )) as StoredRoomSession[];
    // Honor the StoredRoomSession contract: byte fields are real `Uint8Array`s
    // (a structured-clone round-trip can otherwise hand back ArrayBuffers).
    return rows.map(normalizeSession);
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
