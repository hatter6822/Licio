// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.3 — the apps/web entry point that loads/creates a private room and keeps
// it usable across reloads.  `@licio/private-p2p` (MLS/HPKE/AEAD/Ed25519 crypto +
// the reducer + the engine) is heavy and off the synchronous path, so it is pulled
// in by a DYNAMIC `import()` ONLY (a lazy chunk — `check:private-p2p-split` forbids
// a static value import), keeping the protocol/crypto core out of the initial
// bundle.  A private room is hosted only on members' devices, so this module ties
// the engine to BOTH the envelope storage AND the persisted SESSION (the device
// keys, MLS group, epoch keys, manifest) — `PrivateRoomSession` is the one object
// the UI drives.

import type {
  PrivateOpBodyInput,
  PrivateRoomEngine,
  PrivateRoomEngineParams,
  RoomReducerState,
} from '@licio/private-p2p';
import {
  deleteRoomSession,
  getRoomSession,
  listRoomSessions,
  putRoomSession,
  type StoredEpochKeys,
  type StoredRoomSession,
} from './session-store.js';
import { IndexedDbPrivateRoomStorage } from './storage.js';

type P2pModule = typeof import('@licio/private-p2p');

/** Lazily load the code-split `@licio/private-p2p` chunk. */
async function loadP2p(): Promise<P2pModule> {
  return import('@licio/private-p2p');
}

/** Engine params minus storage (the manager supplies the IndexedDB adapter). */
export type LoadPrivateRoomParams = Omit<PrivateRoomEngineParams, 'storage'>;

/**
 * Lazily load `@licio/private-p2p` and construct a `PrivateRoomEngine` over the
 * IndexedDB envelope storage for `params.roomId` (re-verifying every stored
 * envelope, §8.3).  Low-level; most callers use `PrivateRoomSession`.
 */
export async function loadPrivateRoomEngine(
  params: LoadPrivateRoomParams,
): Promise<PrivateRoomEngine> {
  const mod = await loadP2p();
  return mod.PrivateRoomEngine.load({
    ...params,
    storage: new IndexedDbPrivateRoomStorage(params.roomId),
  });
}

/** A room-list entry (no secrets — safe to render). */
export interface RoomSummary {
  readonly roomId: string;
  readonly name: string;
  readonly memberId: string;
  readonly createdAtBucket: string;
}

function manifestName(manifest: unknown): string {
  if (manifest && typeof manifest === 'object' && 'profile' in manifest) {
    const profile = (manifest as { profile?: unknown }).profile;
    if (profile && typeof profile === 'object' && 'name' in profile) {
      const name = (profile as { name?: unknown }).name;
      if (typeof name === 'string') return name;
    }
  }
  return '(untitled room)';
}

function coarseBucket(date = new Date()): string {
  return date.toISOString().slice(0, 13);
}

/** Parameters for founding a new private room from the UI. */
export interface CreatePrivateRoomSessionParams {
  readonly roomName: string;
  readonly roomType: import('@licio/private-p2p').PrivateRoomManifest['profile']['room_type'];
  readonly description?: string;
  readonly founderMemberId: string;
  readonly founderDeviceId: string;
}

/**
 * A single private room the local device belongs to: the engine + its persisted
 * session.  The UI drives `state()` (render), `authorOp()` (post), and the
 * lifecycle statics (`create`/`load`/`list`/`leave`).
 */
export class PrivateRoomSession {
  private constructor(
    private readonly p2p: P2pModule,
    private readonly engine: PrivateRoomEngine,
    private session: StoredRoomSession,
  ) {}

  get roomId(): string {
    return this.session.roomId;
  }
  get memberId(): string {
    return this.session.memberId;
  }
  get deviceId(): string {
    return this.session.deviceId;
  }
  /** The room's display name (from the persisted manifest). */
  get name(): string {
    return manifestName(this.session.manifest);
  }

  /** The current reduced room state (members, stories, contributions, …). */
  state(): RoomReducerState {
    return this.engine.state();
  }

  /** Found a new private room, persist its session, and author the genesis op. */
  static async create(params: CreatePrivateRoomSessionParams): Promise<PrivateRoomSession> {
    const p2p = await loadP2p();
    const roomId = globalThis.crypto.randomUUID();
    const created = await p2p.createPrivateRoom({
      roomId,
      founderMemberId: params.founderMemberId,
      founderDeviceId: params.founderDeviceId,
      profile: {
        name: params.roomName,
        room_type: params.roomType,
        ...(params.description === undefined ? {} : { description: params.description }),
      },
    });

    const engine = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new IndexedDbPrivateRoomStorage(roomId),
    });
    await engine.applyLocalOp(created.genesisOp, created.sealParams);

    const session: StoredRoomSession = {
      roomId,
      roomIdCommitment: created.roomIdCommitment,
      memberId: params.founderMemberId,
      deviceId: params.founderDeviceId,
      signingPrivateKey: created.founder.signingKeyPair.privateKey,
      signingPublicKey: created.engineParams.bootstrapDevices?.[0]?.signingPublicKey ?? '',
      hpkePrivateKey: created.founder.hpkeKeyPair.privateKey,
      hpkePublicKey: created.founder.hpkeKeyPair.publicKey,
      mlsGroupState: p2p.serializeGroupState(created.group),
      epochs: [
        {
          epoch: Number(created.epochState.epoch),
          roomEpochSecret: created.epochState.roomEpochSecret,
          contentWrapKey: created.epochState.keys.contentWrapKey,
        },
      ],
      manifest: created.manifest,
      manifestCommitment: created.manifestCommitment,
      bootstrapDevices: created.engineParams.bootstrapDevices ?? [],
      createdAtBucket: coarseBucket(),
    };
    await putRoomSession(session);
    return new PrivateRoomSession(p2p, engine, session);
  }

  /** Reload a persisted room: reconstruct the engine (re-verifying envelopes). */
  static async load(roomId: string): Promise<PrivateRoomSession | null> {
    const session = await getRoomSession(roomId);
    if (!session) return null;
    const p2p = await loadP2p();
    const epochs = new Map(
      session.epochs.map((entry) => [
        entry.epoch,
        { roomEpochSecret: entry.roomEpochSecret, contentWrapKey: entry.contentWrapKey },
      ]),
    );
    const engine = await p2p.PrivateRoomEngine.load({
      roomId,
      roomIdCommitment: session.roomIdCommitment,
      storage: new IndexedDbPrivateRoomStorage(roomId),
      epochs,
      bootstrapDevices: session.bootstrapDevices,
    });
    return new PrivateRoomSession(p2p, engine, session);
  }

  /** Every private room on this device (for a room list). */
  static async list(): Promise<RoomSummary[]> {
    const sessions = await listRoomSessions();
    return sessions.map((session) => ({
      roomId: session.roomId,
      name: manifestName(session.manifest),
      memberId: session.memberId,
      createdAtBucket: session.createdAtBucket,
    }));
  }

  /** Forget a room locally (delete its session + does not touch other members). */
  static async leave(roomId: string): Promise<void> {
    await deleteRoomSession(roomId);
  }

  private currentEpoch(): StoredEpochKeys {
    let latest = this.session.epochs[0];
    for (const entry of this.session.epochs) {
      if (latest === undefined || entry.epoch > latest.epoch) latest = entry;
    }
    if (latest === undefined) throw new Error('PrivateRoomSession: no epoch keys');
    return latest;
  }

  /**
   * Author any §13 content/membership op under the current epoch, deriving the
   * causal metadata from the local DAG.  The reducer's §11.3 capability check
   * decides whether this member may apply it.
   */
  async authorOp(body: PrivateOpBodyInput): Promise<void> {
    const epoch = this.currentEpoch();
    const keys = await this.p2p.deriveRoomEpochKeys(
      epoch.roomEpochSecret,
      this.session.roomIdCommitment,
    );
    const epochState = {
      epoch: BigInt(epoch.epoch),
      roomEpochSecret: epoch.roomEpochSecret,
      keys,
    };
    const { op, sealParams } = await this.p2p.buildRoomOp(
      {
        roomId: this.session.roomId,
        roomIdCommitment: this.session.roomIdCommitment,
        epochState,
        author: {
          memberId: this.session.memberId,
          deviceId: this.session.deviceId,
          signingKey: this.session.signingPrivateKey,
          seq: this.engine.nextAuthorSeq(this.session.deviceId),
        },
        opId: globalThis.crypto.randomUUID(),
        parents: this.engine.heads(),
        lamport: this.engine.nextLamport(),
      },
      body,
    );
    await this.engine.applyLocalOp(op, sealParams);
  }

  /** Post a story (a top-level content item) into the room. */
  async postStory(input: { title: string; threadId?: string }): Promise<string> {
    const storyId = globalThis.crypto.randomUUID();
    await this.authorOp({
      type: 'story.create',
      story_id: storyId,
      thread_id: input.threadId ?? globalThis.crypto.randomUUID(),
      title: input.title,
      submission_type: 'original_brief',
      topic_ids: [],
      submission_metadata: {},
    });
    return storyId;
  }

  /** Post a comment to a thread. */
  async postComment(input: { threadId: string; body: string }): Promise<string> {
    const contributionId = globalThis.crypto.randomUUID();
    await this.authorOp({
      type: 'contribution.create',
      contribution_id: contributionId,
      thread_id: input.threadId,
      contribution_type: 'comment',
      body_markdown_lite: input.body,
      client_draft_id: globalThis.crypto.randomUUID(),
    });
    return contributionId;
  }
}
