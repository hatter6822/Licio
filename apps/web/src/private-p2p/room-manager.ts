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
  IngestReport,
  InviteSecret,
  JoinRequest,
  JoinRequestVerdict,
  PrivateEncryptedEnvelope,
  PrivateOpBodyInput,
  PrivateRoomEngine,
  PrivateRoomEngineParams,
  RoomReducerState,
  SafetyNumber,
} from '@licio/private-p2p';
import { connectPrivatePeer, type RtcIceServerLike } from './connect-peer.js';
import { type FetchLike, httpRendezvousTransport } from './rendezvous-client.js';
import {
  deleteRoomSession,
  getRoomSession,
  listRoomSessions,
  putRoomSession,
  type StoredEpochKeys,
  type StoredRoomSession,
} from './session-store.js';
import { IndexedDbPrivateRoomStorage } from './storage.js';
import { type PeerChannel, PrivateSyncSession, type SyncCodec } from './sync-session.js';

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

/** The §10.3 HPKE invite public key (base64url) from the opaque stored manifest;
 *  an invitee seals the room secret to it.  `undefined` if the manifest is the
 *  display-only fallback (a join cannot be minted without it). */
function manifestRoomPublicKey(manifest: unknown): string | undefined {
  if (manifest && typeof manifest === 'object' && 'crypto' in manifest) {
    const crypto = (manifest as { crypto?: unknown }).crypto;
    if (crypto && typeof crypto === 'object' && 'room_public_key' in crypto) {
      const key = (crypto as { room_public_key?: unknown }).room_public_key;
      if (typeof key === 'string') return key;
    }
  }
  return undefined;
}

/** §25.6 default compaction cadence: compact after this many post-snapshot ops
 *  (mirrors the engine `SNAPSHOT_CADENCE.everyOps`; overridable for tests). */
export const DEFAULT_COMPACT_EVERY_OPS = 1000;

/** Parameters for founding a new private room from the UI. */
export interface CreatePrivateRoomSessionParams {
  readonly roomName: string;
  readonly roomType: import('@licio/private-p2p').PrivateRoomManifest['profile']['room_type'];
  readonly description?: string;
  readonly founderMemberId: string;
  readonly founderDeviceId: string;
  /** Override the §25.6 compaction cadence (default `DEFAULT_COMPACT_EVERY_OPS`). */
  readonly compactEveryOps?: number;
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
    private readonly compactEveryOps: number,
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

  /**
   * Begin §15.6/§15.7 sync over an ALREADY-ESTABLISHED, post-handshake duplex
   * `PeerChannel` (a live WebRTC channel from `connectPrivatePeer`, an offline-archive
   * relay, or a test loopback).  Drives announce → want → serve → ingest →
   * re-announce-on-progress to convergence; every served envelope passes the engine's
   * own `openOp` verify (§8.3 — the wire confers no trust).  Returns the live session
   * (call `.close()` to stop).  The membership-proving handshake + the channel itself
   * are the carrier's concern (`connectPrivatePeer`); this is the engine driver.
   */
  connectPeer(
    channel: PeerChannel,
    options?: {
      readonly onProgress?: (acceptedOpIds: readonly string[]) => void;
      readonly onError?: (error: unknown) => void;
    },
  ): PrivateSyncSession {
    const codec: SyncCodec = {
      encodeSyncMessage: this.p2p.encodeSyncMessage,
      decodeSyncMessage: this.p2p.decodeSyncMessage,
    };
    const sync = new PrivateSyncSession(this.engine, channel, codec, options ?? {});
    sync.start();
    return sync;
  }

  /**
   * Ingest envelopes delivered out-of-band (a peer push, an imported archive) through
   * the engine's verify-before-use path (§8.3).  Returns what was accepted vs.
   * quarantined so a UI can surface sync/quarantine status.
   */
  async ingest(envelopes: readonly PrivateEncryptedEnvelope[]): Promise<IngestReport> {
    return this.engine.ingest(envelopes);
  }

  /** Map the manifest's §13.1 transport mode to the carrier's binary mode
   *  (anything other than `direct_allowed` is treated as relay-only for IP privacy). */
  private transportMode(): 'relay_only' | 'direct_allowed' {
    const manifest = this.session.manifest as {
      profile?: { transport_mode?: unknown };
    };
    return manifest?.profile?.transport_mode === 'direct_allowed' ? 'direct_allowed' : 'relay_only';
  }

  /**
   * Establish a LIVE WebRTC connection to another current-epoch member and begin
   * syncing this room over it (WS-S.4.3).  Discovers the peer via the server-blind
   * §15.2 rendezvous (the rendezvous key IS the capability), seals SDP/ICE under the
   * §15.4 pairwise channel, proves membership via the §15.5 handshake (the peer's
   * device must be REGISTERED + ACTIVE in this room's converged state — resolved from
   * `engine.state().devices`), then drives the §15.7 op-exchange to convergence.
   * Returns the live sync session (`close()` to disconnect).  Rejects on
   * timeout/abort or a failed membership handshake (no op is ever served first).
   */
  async connect(options?: {
    readonly transportMode?: 'relay_only' | 'direct_allowed';
    readonly iceServers?: RtcIceServerLike[];
    readonly fetchImpl?: FetchLike;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly onProgress?: (acceptedOpIds: readonly string[]) => void;
    readonly onError?: (error: unknown) => void;
  }): Promise<PrivateSyncSession> {
    const epoch = this.currentEpoch();
    const keys = await this.p2p.deriveRoomEpochKeys(
      epoch.roomEpochSecret,
      this.session.roomIdCommitment,
    );
    const fetchImpl: FetchLike =
      options?.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit | undefined));
    const channel = await connectPrivatePeer({
      p2p: this.p2p,
      rendezvous: httpRendezvousTransport(fetchImpl),
      roomIdCommitment: this.session.roomIdCommitment,
      epoch: epoch.epoch,
      rendezvousKey: keys.rendezvousKey,
      selfDeviceId: this.session.deviceId,
      selfSigningKey: this.session.signingPrivateKey,
      resolveDevice: (deviceId) => {
        const device = this.engine.state().devices.get(deviceId);
        if (!device) return undefined;
        return {
          signingPublicKey: device.signingPublicKey,
          activeAtEpoch: !device.removed && device.addedAtEpoch <= epoch.epoch,
        };
      },
      transportMode: options?.transportMode ?? this.transportMode(),
      nowMs: () => Date.now(),
      ...(options?.iceServers ? { iceServers: options.iceServers } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return this.connectPeer(channel, {
      ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options?.onError ? { onError: options.onError } : {}),
    });
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
    return new PrivateRoomSession(
      p2p,
      engine,
      session,
      params.compactEveryOps ?? DEFAULT_COMPACT_EVERY_OPS,
    );
  }

  /** Reload a persisted room: reconstruct the engine (resuming from the §14.5 base
   *  if one was persisted, so only post-snapshot envelopes are re-verified). */
  static async load(
    roomId: string,
    options?: { readonly compactEveryOps?: number },
  ): Promise<PrivateRoomSession | null> {
    const session = await getRoomSession(roomId);
    if (!session) return null;
    const p2p = await loadP2p();
    // Re-validate the persisted manifest through the schema (the manager owns the
    // dynamically-imported schema; this module's type-only import cannot).  A
    // valid manifest is adopted as typed state; a corrupted DISPLAY-ONLY manifest
    // must not brick an otherwise-intact room (its envelopes + epoch keys are
    // independent and the cryptographic binding is the manifest COMMITMENT,
    // verified at join), so fall back to the opaque value — availability over
    // strictness for a non-cryptographic field (SPEC §6.9).
    const manifestResult = p2p.privateRoomManifestSchema.safeParse(session.manifest);
    const validatedSession = manifestResult.success
      ? { ...session, manifest: manifestResult.data }
      : session;
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
      // Resume from the persisted §14.5 base, if any (its covered envelopes were
      // pruned, so only the post-snapshot ones are re-verified on load).
      ...(session.snapshotBase ? { base: session.snapshotBase } : {}),
    });
    return new PrivateRoomSession(
      p2p,
      engine,
      validatedSession,
      options?.compactEveryOps ?? DEFAULT_COMPACT_EVERY_OPS,
    );
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

  /** Parse + validate a pasted §10.3 invite JSON through the schema (fail-closed:
   *  returns `null` on malformed JSON or a non-conforming payload). */
  static async parseInvite(json: string): Promise<InviteSecret | null> {
    const p2p = await loadP2p();
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
    const result = p2p.inviteSecretSchema.safeParse(value);
    return result.success ? result.data : null;
  }

  /** Parse + validate a pasted §12.3 join-request JSON through the schema
   *  (fail-closed: `null` on malformed JSON or a non-conforming payload). */
  static async parseJoinRequest(json: string): Promise<JoinRequest | null> {
    const p2p = await loadP2p();
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
    const result = p2p.joinRequestSchema.safeParse(value);
    return result.success ? result.data : null;
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
    await this.persistCompactionIfDue();
  }

  /**
   * Run the §25.6 compaction cadence after authoring: if due, the engine authors an
   * admin-signed in-band §14.5 `snapshot.commit`, compacts + drops the covered
   * envelopes from IndexedDB, and returns the new SEALED base, which we persist into
   * the session so a reload resumes from it (re-verifying only the post-snapshot
   * envelopes — bounding reload cost for a long-lived room).  A non-admin member's
   * commit is rejected by the reducer, so `maybeCompact` is a no-op for them.
   */
  private async persistCompactionIfDue(): Promise<void> {
    const epoch = this.currentEpoch();
    const base = await this.engine.maybeCompact(this.compactEveryOps, {
      epoch: epoch.epoch,
      roomEpochSecret: epoch.roomEpochSecret,
      contentWrapKey: epoch.contentWrapKey,
      author: {
        memberId: this.session.memberId,
        deviceId: this.session.deviceId,
        signingKey: this.session.signingPrivateKey,
      },
      opId: globalThis.crypto.randomUUID(),
      snapshotId: globalThis.crypto.randomUUID(),
    });
    if (!base) return;
    this.session = { ...this.session, snapshotBase: base };
    await putRoomSession(this.session);
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

  // --- §10.3 invite / §12.3 join / §15.5 safety-number (WS-S.7.4) -------------

  /**
   * Mint a §10.3 invite and HPKE-seal it to the INVITEE's public key (which the
   * admin learns out-of-band — the JoinPanel shows it).  Returns BOTH the
   * `InviteSecret` (the admin keeps it to verify the resulting join request) and
   * the URL FRAGMENT to deliver out-of-band; the secret lives only in the
   * fragment, so an ordinary HTTP request never transmits it to a server.
   * Defaults to a single-use invite expiring in 24h granting `member`.
   */
  async createInvite(params: {
    /** The invitee's HPKE recipient public key (base64url), learned out-of-band. */
    readonly inviteePublicKey: string;
    readonly grantedRole?: InviteSecret['granted_role'];
    readonly expiresAt?: string;
    readonly maxUses?: number;
    /** The base URL the fragment hangs off (default: the public join path). */
    readonly baseUrl?: string;
  }): Promise<{ invite: InviteSecret; inviteUrl: string }> {
    const roomPublicKey = manifestRoomPublicKey(this.session.manifest);
    if (roomPublicKey === undefined) {
      throw new Error('createInvite: the room manifest carries no invite public key');
    }
    const expiresAt = params.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const invite = this.p2p.createRoomInvite({
      roomPublicKey,
      grantedRole: params.grantedRole ?? 'member',
      expiresAt,
      ...(params.maxUses === undefined ? {} : { maxUses: params.maxUses }),
    });
    const sealed = await this.p2p.sealInvite(
      this.p2p.fromBase64Url(params.inviteePublicKey),
      invite,
    );
    const inviteUrl = this.p2p.buildInviteUrl(
      params.baseUrl ?? 'https://licio.app/private/join',
      sealed,
    );
    return { invite, inviteUrl };
  }

  /**
   * The invitee side (a device that is NOT yet in a room, so this is static):
   * generate a fresh HPKE recipient key pair + an MLS KeyPackage, then — given the
   * sealed invite fragment — open it and build the §12.3 `JoinRequest` blob to
   * hand back to an admin.  Returns the joiner's HPKE public key (to share with
   * the admin so they can seal the invite) and a `complete(sealedInvite)` step that
   * opens the invite (fail-closed, surfacing the `HpkeError.reason`) and produces
   * the request blob.  The MLS Welcome delivery that finishes the join is the
   * device-session slice (tracked in docs/private-p2p/README.md).
   */
  static async prepareJoinRequest(params: {
    readonly proposedDisplayName: string;
    /** A coarse time bucket (never an exact timestamp). */
    readonly requestedAtBucket?: string;
  }): Promise<{
    readonly inviteePublicKey: string;
    complete(sealedInvite: string): Promise<{ invite: InviteSecret; request: JoinRequest }>;
  }> {
    const p2p = await loadP2p();
    const hpke = await p2p.generateRecipientKeyPair();
    const keyPackage = await p2p.generateMemberKeyPackage(p2p.utf8(globalThis.crypto.randomUUID()));
    const inviteePublicKey = p2p.toBase64Url(hpke.publicKey);
    const requestedAtBucket = params.requestedAtBucket ?? coarseBucket();
    return {
      inviteePublicKey,
      async complete(sealedInvite: string) {
        const invite = await p2p.openInvite(hpke.privateKey, hpke.publicKey, sealedInvite);
        const request = await p2p.buildJoinRequest({
          invite,
          keyPackage: keyPackage.publicPackage,
          proposedDisplayName: params.proposedDisplayName,
          requestedAtBucket,
        });
        return { invite, request };
      },
    };
  }

  /**
   * Verify a pasted §12.3 join request against the invite this admin minted, then
   * admit the device (the MLS Add → new epoch), author + apply the signed
   * `member.add` op (carrying `proposed_display_name` into the converged member
   * display name), persist the advanced group + the new epoch keys, and return the
   * verdict.  On any rejection (expired/exhausted/invite-id/proof/key-package) the
   * verdict's `reason` is surfaced verbatim and NO state changes.
   */
  async admitJoinRequest(
    invite: InviteSecret,
    request: JoinRequest,
    options?: { readonly usesSoFar?: number; readonly now?: Date },
  ): Promise<JoinRequestVerdict> {
    const verdict = await this.p2p.verifyJoinRequest(invite, request, {
      now: options?.now ?? new Date(),
      ...(options?.usesSoFar === undefined ? {} : { usesSoFar: options.usesSoFar }),
    });
    if (!verdict.ok) return verdict;

    const group = await this.p2p.deserializeGroupState(this.session.mlsGroupState);
    const invited = await this.p2p.inviteDevice(group, verdict.keyPackage);
    const newEpochState = await this.p2p.deriveEpochState(
      invited.group,
      this.session.roomIdCommitment,
      this.session.manifestCommitment,
    );
    const epoch = Number(newEpochState.epoch);
    this.engine.addEpochKeys(epoch, this.p2p.heldKeysOf(newEpochState));

    const newMemberId = globalThis.crypto.randomUUID();
    const newDeviceId = globalThis.crypto.randomUUID();
    const { op, sealParams } = await this.p2p.buildMemberAddOp(
      {
        roomId: this.session.roomId,
        roomIdCommitment: this.session.roomIdCommitment,
        epochState: newEpochState,
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
      {
        memberId: newMemberId,
        deviceId: newDeviceId,
        // The signed `member.add` records the joining device's LONG-TERM keys: its
        // Ed25519 signing key (the MLS leaf's signature key) and its HPKE init key —
        // both authenticated by the verified KeyPackage, so a relay cannot inject a
        // different device key.
        signingPublicKey: this.p2p.toBase64Url(verdict.keyPackage.leafNode.signaturePublicKey),
        hpkePublicKey: this.p2p.toBase64Url(verdict.keyPackage.initKey),
        mlsKeyPackage: request.recipient_device_key_package,
        role: verdict.grantedRole,
        displayName: request.proposed_display_name,
      },
    );
    await this.engine.applyLocalOp(op, sealParams);

    const epochs = [
      ...this.session.epochs.filter((e) => e.epoch !== epoch),
      {
        epoch,
        roomEpochSecret: newEpochState.roomEpochSecret,
        contentWrapKey: newEpochState.keys.contentWrapKey,
      },
    ];
    this.session = {
      ...this.session,
      mlsGroupState: this.p2p.serializeGroupState(invited.group),
      epochs,
    };
    await putRoomSession(this.session);
    return verdict;
  }

  /**
   * Compute the §15.5 / §20.4 safety number (SAS) for the local device ⇄ another
   * member's device, for out-of-band comparison over a TRUSTED channel.  Reads
   * each device's LONG-TERM signing public key from the reduced state (never the
   * ephemeral session key).  Returns `null` if `otherDeviceId` is unknown.
   */
  async computeMemberSafetyNumber(otherDeviceId: string): Promise<SafetyNumber | null> {
    const state = this.engine.state();
    const remote = state.devices.get(otherDeviceId);
    if (!remote || remote.removed) return null;
    return this.p2p.computeSafetyNumber({
      roomIdCommitment: this.session.roomIdCommitment,
      local: { deviceId: this.session.deviceId, signingPublicKey: this.session.signingPublicKey },
      remote: { deviceId: remote.deviceId, signingPublicKey: remote.signingPublicKey },
    });
  }
}
