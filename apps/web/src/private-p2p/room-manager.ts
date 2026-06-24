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
  KeyPackageBundle,
  PrivateEncryptedEnvelope,
  PrivateOpBodyInput,
  PrivateRoomEngine,
  PrivateRoomEngineParams,
  PrivateRoomStorage,
  RoomReducerState,
  SafetyNumber,
} from '@licio/private-p2p';

/**
 * The §12.3 join GRANT an admin returns from `admitJoinRequest` and the joiner feeds to
 * `completeJoin`: the MLS Welcome, the room identity/manifest, the assigned member/device
 * ids, the current device roster (the joiner's bootstrap trust set), and a §15.9 archive
 * carrying a §14.5 snapshot sealed under the new epoch (the joiner's view of the existing
 * state).  Delivered admin→joiner over the §10.3 channel; the bytes confer no trust.
 */
export interface JoinGrant {
  readonly welcome: Uint8Array;
  readonly roomId: string;
  readonly roomIdCommitment: Uint8Array;
  readonly manifest: unknown;
  readonly manifestCommitment: Uint8Array;
  readonly assignedMemberId: string;
  readonly assignedDeviceId: string;
  readonly bootstrapDevices: readonly {
    readonly deviceId: string;
    readonly signingPublicKey: string;
  }[];
  readonly archive: Uint8Array;
}

/** The result of `admitJoinRequest`: the verify verdict, plus (on success) the GRANT the
 *  admin delivers to the joiner so it can `completeJoin`. */
export interface AdmitResult {
  readonly verdict: JoinRequestVerdict;
  readonly grant?: JoinGrant;
}

function grantBytesToB64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function grantB64UrlToBytes(b64url: string): Uint8Array {
  const std = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std.length % 4 === 0 ? std : std + '='.repeat(4 - (std.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Serialize a {@link JoinGrant} to a transportable JSON blob (the admin sends this back
 *  to the joiner over the §10.3 channel; the bytes confer no trust). */
export function serializeJoinGrant(grant: JoinGrant): string {
  return JSON.stringify({
    v: 1,
    welcome: grantBytesToB64Url(grant.welcome),
    roomId: grant.roomId,
    roomIdCommitment: grantBytesToB64Url(grant.roomIdCommitment),
    manifest: grant.manifest,
    manifestCommitment: grantBytesToB64Url(grant.manifestCommitment),
    assignedMemberId: grant.assignedMemberId,
    assignedDeviceId: grant.assignedDeviceId,
    bootstrapDevices: grant.bootstrapDevices,
    archive: grantBytesToB64Url(grant.archive),
  });
}

/** Parse a serialized {@link JoinGrant} fail-closed (returns `null` on malformed JSON or a
 *  structurally invalid payload).  Every field is re-validated; the engine re-verifies the
 *  archive's snapshot + envelopes regardless (§8.3 — the blob confers no trust). */
export function parseJoinGrant(json: string): JoinGrant | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const g = value as Record<string, unknown>;
  const str = (k: string): string | null => (typeof g[k] === 'string' ? (g[k] as string) : null);
  const roomId = str('roomId');
  const assignedMemberId = str('assignedMemberId');
  const assignedDeviceId = str('assignedDeviceId');
  const welcome = str('welcome');
  const roomIdCommitment = str('roomIdCommitment');
  const manifestCommitment = str('manifestCommitment');
  const archive = str('archive');
  if (
    roomId === null ||
    assignedMemberId === null ||
    assignedDeviceId === null ||
    welcome === null ||
    roomIdCommitment === null ||
    manifestCommitment === null ||
    archive === null ||
    !('manifest' in g) ||
    !Array.isArray(g['bootstrapDevices'])
  ) {
    return null;
  }
  const bootstrapDevices: { deviceId: string; signingPublicKey: string }[] = [];
  for (const d of g['bootstrapDevices']) {
    if (
      typeof d !== 'object' ||
      d === null ||
      typeof (d as Record<string, unknown>)['deviceId'] !== 'string' ||
      typeof (d as Record<string, unknown>)['signingPublicKey'] !== 'string'
    ) {
      return null;
    }
    const dev = d as { deviceId: string; signingPublicKey: string };
    bootstrapDevices.push({ deviceId: dev.deviceId, signingPublicKey: dev.signingPublicKey });
  }
  try {
    return {
      welcome: grantB64UrlToBytes(welcome),
      roomId,
      roomIdCommitment: grantB64UrlToBytes(roomIdCommitment),
      manifest: g['manifest'],
      manifestCommitment: grantB64UrlToBytes(manifestCommitment),
      assignedMemberId,
      assignedDeviceId,
      bootstrapDevices,
      archive: grantB64UrlToBytes(archive),
    };
  } catch {
    return null;
  }
}

import { loadUpdateChannelConfig } from '../update/config.js';
import { requirePrivateBundleTrusted } from '../update/gate.js';
import {
  connectPrivatePeer,
  type RendezvousCapHooks,
  type RtcIceServerLike,
} from './connect-peer.js';
import {
  type CapIssuanceOpBody,
  RendezvousCapManager,
  type RendezvousCapStorage,
} from './rendezvous-cap-manager.js';
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
import {
  type MeshController,
  type MeshDial,
  maintainConnection,
  maintainMesh,
  type PeerChannel,
  PrivateSyncSession,
  type ReconnectController,
  type ReconnectStatus,
  type SyncCodec,
} from './sync-session.js';

type P2pModule = typeof import('@licio/private-p2p');

/** Lazily load the code-split `@licio/private-p2p` chunk. */
async function loadP2p(): Promise<P2pModule> {
  return import('@licio/private-p2p');
}

/**
 * Derive a device id deterministically from its Ed25519 signing public key (base64url):
 * `base64url(SHA-256(rawPubKey))`.  Used so device_id is a 1:1 function of the
 * proof-bound key — a joiner cannot pick a colliding id, and the SAME value is the MLS
 * KeyPackage credential identity, so `utf8(deviceId)` resolves the leaf for removal.  The
 * admin re-derives this from the proof-bound `verdict.deviceSigningPublicKey` and checks
 * the keypackage identity matches (fail-closed), binding the reducer device to the key.
 */
async function deviceIdFromSigningKey(
  p2p: P2pModule,
  signingPublicKeyB64Url: string,
): Promise<string> {
  return p2p.toBase64Url(await p2p.sha256(p2p.fromBase64Url(signingPublicKeyB64Url)));
}

/** Thrown when the §20.6 verify-before-unlock gate locks: the running private-mode
 *  bundle is not reproducible/signed/transparency-logged, so room keys stay sealed. */
export class PrivateBundleLockedError extends Error {
  constructor(readonly reason: string) {
    super(`private bundle locked (verify-before-unlock): ${reason}`);
    this.name = 'PrivateBundleLockedError';
  }
}

/**
 * §20.6 / WS-S.10 verify-before-unlock.  When the update channel is CONFIGURED (a
 * maintainer signer set is pinned into this build), the running private-mode bundle
 * MUST be reproducible + signed + present in the transparency log before any room key
 * is unlocked; an untrusted verdict throws `PrivateBundleLockedError` (rooms lock with
 * the §20.6 copy).  A no-op when NO signer set is configured (dev/test) — the control
 * engages only when a release pins it, and a build-pinned signer set cannot be
 * unconfigured by an attacker (it is baked into the bundle, not runtime state).
 */
async function ensurePrivateBundleTrusted(): Promise<void> {
  if (loadUpdateChannelConfig().trustedSignerPublicKeys.length === 0) return;
  const verdict = await requirePrivateBundleTrusted();
  if (!verdict.trusted) {
    throw new PrivateBundleLockedError(verdict.reason ?? 'not_in_transparency_log');
  }
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
  await ensurePrivateBundleTrusted();
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
  /** Storage factory (DI seam — defaults to the IndexedDB adapter; tests inject an
   *  in-memory store so two same-room sessions stay isolated). */
  readonly createStorage?: (roomId: string) => PrivateRoomStorage;
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

  /** Live sync sessions (so a §10.9 membership change can broadcast its MLS commit to
   *  every currently-connected member).  Closed sessions no-op on send; they are pruned
   *  lazily on the next broadcast. */
  private readonly activeSessions = new Set<PrivateSyncSession>();

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

  // --- Tier-2 rendezvous cap (docs/private-p2p/TIER2-RENDEZVOUS-CAP.md §11) ----------------
  private capManager: RendezvousCapManager | undefined;
  private capSyncing = false;

  /** Device-local persistence for the cap `nid` + issuer seed (32-byte pseudonym secrets) in
   *  the private-p2p IndexedDB store — the SAME trust boundary as the room's epoch keys, off
   *  the origin-wide localStorage. */
  private capStorage(): RendezvousCapStorage {
    const store = new IndexedDbPrivateRoomStorage(this.session.roomId);
    return {
      loadNid: () => store.getCapSecret('nid'),
      saveNid: (n) => store.putCapSecret('nid', n),
      loadIssuerSeed: () => store.getCapSecret('issuer-seed'),
      saveIssuerSeed: (s) => store.putCapSecret('issuer-seed', s),
    };
  }

  /** Drive one round of the cap protocol (publish our commitment / install our credential /
   *  issue as admin). Best-effort + fail-open: any failure leaves the rendezvous on Tier-1.
   *  Re-entrancy-guarded (authoring ops re-enters ingest). */
  private async syncCap(): Promise<void> {
    if (this.capSyncing) return;
    this.capSyncing = true;
    try {
      this.capManager ??= new RendezvousCapManager(this.capStorage());
      const isAdmin =
        this.engine.state().members.get(this.session.memberId)?.capabilities.has('admin') ?? false;
      await this.capManager.sync({
        engine: this.engine,
        deviceId: this.session.deviceId,
        epoch: this.currentEpoch().epoch,
        isAdmin,
        authorRequest: (commitmentWithProof) =>
          this.authorOp({ type: 'rendezvous.request', commitment_with_proof: commitmentWithProof }),
        authorIssue: (body: CapIssuanceOpBody) =>
          this.authorOp({
            type: 'rendezvous.issue',
            target_epoch: body.target_epoch,
            issuer_public_key: body.issuer_public_key,
            credentials: body.credentials.map((c) => ({ ...c })),
          }),
      });
    } finally {
      this.capSyncing = false;
    }
  }

  /** The connect-peer cap hooks for `epoch` (or undefined ⇒ this device rides Tier-1). */
  private async capHooks(epoch: number): Promise<RendezvousCapHooks | undefined> {
    this.capManager ??= new RendezvousCapManager(this.capStorage());
    return this.capManager.hooks(epoch);
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
      readonly onClose?: (graceful: boolean) => void;
    },
  ): PrivateSyncSession {
    const codec: SyncCodec = {
      encodeSyncMessage: this.p2p.encodeSyncMessage,
      decodeSyncMessage: this.p2p.decodeSyncMessage,
    };
    const sync = new PrivateSyncSession(this.engine, channel, codec, {
      ...(options ?? {}),
      // The manager owns §10.9 commit application (it holds the MLS group); a peer's
      // commit advances THIS device's epoch + re-opens the pending content.
      onMlsCommit: (commit, epoch) => this.applyIncomingCommit(commit, epoch),
    });
    this.activeSessions.add(sync);
    sync.start();
    return sync;
  }

  /**
   * §10.9 — apply an MLS Commit received from a peer over a live session: advance THIS
   * device's MLS group to the new epoch, derive + install the new epoch keys, re-open the
   * content that was pending on that key, and persist the advanced group + keys.  The
   * sync session then re-announces + walks the newly-decryptable frontier.  Fail-closed:
   * a bad commit throws (applyCommit), leaving the group/keys untouched.
   */
  private async applyIncomingCommit(commit: Uint8Array, epoch: number): Promise<void> {
    const group = await this.p2p.deserializeGroupState(this.session.mlsGroupState);
    const advanced = await this.p2p.applyCommit(group, this.p2p.decodeCommit(commit));
    const newEpochState = await this.p2p.deriveEpochState(
      advanced,
      this.session.roomIdCommitment,
      this.session.manifestCommitment,
    );
    if (Number(newEpochState.epoch) !== epoch) {
      throw new Error(
        `applyIncomingCommit: commit reached epoch ${Number(newEpochState.epoch)}, expected ${epoch}`,
      );
    }
    const epochNum = Number(newEpochState.epoch);
    this.engine.addEpochKeys(epochNum, this.p2p.heldKeysOf(newEpochState));
    await this.engine.retryPending();
    this.session = {
      ...this.session,
      mlsGroupState: this.p2p.serializeGroupState(advanced),
      epochs: [
        ...this.session.epochs.filter((e) => e.epoch !== epochNum),
        {
          epoch: epochNum,
          roomEpochSecret: newEpochState.roomEpochSecret,
          contentWrapKey: newEpochState.keys.contentWrapKey,
        },
      ],
    };
    await putRoomSession(this.session);
  }

  /** Broadcast a §10.9 MLS commit to every currently-connected member (so existing
   *  members advance to the new epoch), pruning any closed sessions. */
  private broadcastCommit(commit: Uint8Array, epoch: number): void {
    for (const session of this.activeSessions) session.sendMlsCommit(commit, epoch);
  }

  /**
   * Ingest envelopes delivered out-of-band (a peer push, an imported archive) through
   * the engine's verify-before-use path (§8.3).  Returns what was accepted vs.
   * quarantined so a UI can surface sync/quarantine status.
   */
  async ingest(envelopes: readonly PrivateEncryptedEnvelope[]): Promise<IngestReport> {
    const report = await this.engine.ingest(envelopes);
    // Advance the Tier-2 cap (publish/install/issue) after new ops land; fail-open to Tier-1.
    await this.syncCap().catch(() => {});
    return report;
  }

  /**
   * Export this room as a §15.9 ciphertext-only offline archive (a §14.5 sealed snapshot,
   * if compacted, plus the retained envelopes) for offline sharing / device handoff.  The
   * archive confers no trust — an importer re-validates every envelope (§8.3).
   */
  async exportArchive(): Promise<Uint8Array> {
    return this.engine.exportArchive({
      kind: 'encrypted_member_backup',
      createdAtBucket: coarseBucket(),
    });
  }

  /**
   * Import a §15.9 offline archive into this room (bootstrap from its sealed snapshot if
   * this engine is fresh, then ingest + re-validate every envelope — the container confers
   * no trust).  Returns the accepted/quarantined report.
   */
  async importArchive(bytes: Uint8Array): Promise<IngestReport> {
    return this.engine.importArchive(bytes);
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
    readonly onClose?: (graceful: boolean) => void;
  }): Promise<PrivateSyncSession> {
    const epoch = this.currentEpoch();
    const keys = await this.p2p.deriveRoomEpochKeys(
      epoch.roomEpochSecret,
      this.session.roomIdCommitment,
    );
    const fetchImpl: FetchLike =
      options?.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit | undefined));
    // Advance enrollment, then fetch the Tier-2 cap hooks (undefined ⇒ ride Tier-1).
    await this.syncCap().catch(() => {});
    const rendezvousCap = await this.capHooks(epoch.epoch).catch(() => undefined);
    const { channel } = await connectPrivatePeer({
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
      ...(rendezvousCap ? { rendezvousCap } : {}),
      ...(options?.iceServers ? { iceServers: options.iceServers } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return this.connectPeer(channel, {
      ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options?.onError ? { onError: options.onError } : {}),
      ...(options?.onClose ? { onClose: options.onClose } : {}),
    });
  }

  /**
   * §15.4 — connect AND auto-maintain the connection across network drops (the mobile/NAT
   * reality): on a non-graceful channel drop it RE-DIALS with bounded backoff; a peer that
   * sent `bye` (a deliberate leave) or a local `close()` stops it.  Returns a controller —
   * `close()` to stop + gracefully leave, `status()` for the live lifecycle.
   */
  connectAndMaintain(options?: {
    readonly transportMode?: 'relay_only' | 'direct_allowed';
    readonly iceServers?: RtcIceServerLike[];
    readonly fetchImpl?: FetchLike;
    readonly timeoutMs?: number;
    readonly onProgress?: (acceptedOpIds: readonly string[]) => void;
    readonly onError?: (error: unknown) => void;
    readonly maxAttempts?: number;
    readonly backoffMs?: number;
    readonly onStatus?: (status: ReconnectStatus) => void;
  }): ReconnectController {
    return maintainConnection(
      (onClose) =>
        this.connect({
          ...(options?.transportMode ? { transportMode: options.transportMode } : {}),
          ...(options?.iceServers ? { iceServers: options.iceServers } : {}),
          ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
          ...(options?.onError ? { onError: options.onError } : {}),
          onClose,
        }),
      {
        ...(options?.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options?.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
        ...(options?.onStatus ? { onStatus: options.onStatus } : {}),
      },
    );
  }

  /**
   * §15.6 — connect to a bounded MESH of online members (not just the first peer found),
   * so the local engine converges with the union ALL of them hold.  Each peer gets its own
   * `PrivateSyncSession`; a dropped peer frees a slot the re-poll refills.  Returns a
   * `MeshController` (`close()` leaves every peer, `peers()` lists the connected set).
   */
  connectMesh(options?: {
    readonly transportMode?: 'relay_only' | 'direct_allowed';
    readonly iceServers?: RtcIceServerLike[];
    readonly fetchImpl?: FetchLike;
    /** Per-dial deadline (default 8s) — a dial that finds no NEW peer times out → the
     *  mesh waits one re-poll interval and tries again. */
    readonly dialTimeoutMs?: number;
    readonly onProgress?: (acceptedOpIds: readonly string[]) => void;
    readonly onError?: (error: unknown) => void;
    readonly maxPeers?: number;
    readonly rePollIntervalMs?: number;
    readonly onMeshChange?: (peers: readonly string[]) => void;
  }): MeshController {
    const fetchImpl: FetchLike =
      options?.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit | undefined));
    const dialTimeoutMs = options?.dialTimeoutMs ?? 8_000;
    const dial: MeshDial = async (connected, onDrop) => {
      const epoch = this.currentEpoch();
      const keys = await this.p2p.deriveRoomEpochKeys(
        epoch.roomEpochSecret,
        this.session.roomIdCommitment,
      );
      await this.syncCap().catch(() => {});
      const rendezvousCap = await this.capHooks(epoch.epoch).catch(() => undefined);
      let result: { channel: PeerChannel; peerDeviceId: string };
      try {
        result = await connectPrivatePeer({
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
          excludePeerDeviceIds: connected,
          transportMode: options?.transportMode ?? this.transportMode(),
          nowMs: () => Date.now(),
          timeoutMs: dialTimeoutMs,
          ...(rendezvousCap ? { rendezvousCap } : {}),
          ...(options?.iceServers ? { iceServers: options.iceServers } : {}),
        });
      } catch {
        return null; // no NEW peer within the dial deadline — re-poll later
      }
      const session = this.connectPeer(result.channel, {
        ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options?.onError ? { onError: options.onError } : {}),
        onClose: (graceful) => onDrop(result.peerDeviceId, graceful),
      });
      return { peerId: result.peerDeviceId, session };
    };
    return maintainMesh(dial, {
      ...(options?.maxPeers !== undefined ? { maxPeers: options.maxPeers } : {}),
      ...(options?.rePollIntervalMs !== undefined
        ? { rePollIntervalMs: options.rePollIntervalMs }
        : {}),
      ...(options?.onMeshChange ? { onMeshChange: options.onMeshChange } : {}),
    });
  }

  /** Found a new private room, persist its session, and author the genesis op. */
  static async create(params: CreatePrivateRoomSessionParams): Promise<PrivateRoomSession> {
    await ensurePrivateBundleTrusted();
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
      storage: params.createStorage?.(roomId) ?? new IndexedDbPrivateRoomStorage(roomId),
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
    await ensurePrivateBundleTrusted();
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
  async postStory(input: { title: string; threadId?: string; body?: string }): Promise<string> {
    const storyId = globalThis.crypto.randomUUID();
    await this.authorOp({
      type: 'story.create',
      story_id: storyId,
      thread_id: input.threadId ?? globalThis.crypto.randomUUID(),
      title: input.title,
      // A text story carries its UGC body; a link/media story omits it (no empty field on the wire).
      ...(input.body !== undefined && input.body.length > 0
        ? { body_markdown_lite: input.body }
        : {}),
      submission_type: 'original_brief',
      topic_ids: [],
      submission_metadata: {},
    });
    return storyId;
  }

  /** Post a comment to a thread.  `contributionId` lets a caller (the migration import) pass a
   *  DETERMINISTIC id so re-authoring is idempotent and replies can remap their parent;
   *  `parentContributionId` preserves nested-reply structure (§13.5 `parent_contribution_id`). */
  async postComment(input: {
    threadId: string;
    body: string;
    contributionId?: string;
    parentContributionId?: string;
  }): Promise<string> {
    const contributionId = input.contributionId ?? globalThis.crypto.randomUUID();
    await this.authorOp({
      type: 'contribution.create',
      contribution_id: contributionId,
      thread_id: input.threadId,
      contribution_type: 'comment',
      body_markdown_lite: input.body,
      client_draft_id: globalThis.crypto.randomUUID(),
      ...(input.parentContributionId !== undefined
        ? { parent_contribution_id: input.parentContributionId }
        : {}),
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
    /** Storage factory (DI seam — see {@link CreatePrivateRoomSessionParams}). */
    readonly createStorage?: (roomId: string) => PrivateRoomStorage;
  }): Promise<{
    readonly inviteePublicKey: string;
    complete(sealedInvite: string): Promise<{ invite: InviteSecret; request: JoinRequest }>;
    /** §12.3 finish — once the admin returns the grant (Welcome + the current-state
     *  bootstrap), join the MLS group and construct + persist a usable room session. */
    completeJoin(grant: JoinGrant): Promise<PrivateRoomSession>;
  }> {
    await ensurePrivateBundleTrusted();
    const p2p = await loadP2p();
    const hpke = await p2p.generateRecipientKeyPair();
    // The joiner's LONG-TERM device signing key (Ed25519): the key it AUTHORS ops with,
    // SEPARATE from the MLS leaf signature key (no cross-protocol reuse, symmetric with
    // the founder).  Its public key rides the join request, proof-bound (§12.3).
    const signing = await p2p.generateDeviceSigningKeyPair(false);
    const deviceSigningPublicKey = p2p.toBase64Url(await p2p.exportPublicKeyRaw(signing.publicKey));
    // The device id is DERIVED from the (proof-bound) signing key, not chosen freely, and
    // doubles as the MLS KeyPackage credential identity — so device_id is a 1:1 function
    // of the unforgeable key (no joiner-chosen collision), and `utf8(deviceId)` still
    // resolves the MLS leaf for §10.9 removal (the admin re-derives + checks the same).
    const deviceId = await deviceIdFromSigningKey(p2p, deviceSigningPublicKey);
    const keyPackage = await p2p.generateMemberKeyPackage(p2p.utf8(deviceId));
    const inviteePublicKey = p2p.toBase64Url(hpke.publicKey);
    const requestedAtBucket = params.requestedAtBucket ?? coarseBucket();
    return {
      inviteePublicKey,
      async complete(sealedInvite: string) {
        const invite = await p2p.openInvite(hpke.privateKey, hpke.publicKey, sealedInvite);
        const request = await p2p.buildJoinRequest({
          invite,
          keyPackage: keyPackage.publicPackage,
          deviceSigningPublicKey,
          proposedDisplayName: params.proposedDisplayName,
          requestedAtBucket,
        });
        return { invite, request };
      },
      completeJoin(grant: JoinGrant) {
        return PrivateRoomSession.finishJoin(grant, {
          bundle: keyPackage,
          signingPrivateKey: signing.privateKey,
          signingPublicKey: deviceSigningPublicKey,
          hpkePrivateKey: hpke.privateKey,
          hpkePublicKey: hpke.publicKey,
          ...(params.createStorage ? { createStorage: params.createStorage } : {}),
        });
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
  ): Promise<AdmitResult> {
    const verdict = await this.p2p.verifyJoinRequest(invite, request, {
      now: options?.now ?? new Date(),
      ...(options?.usesSoFar === undefined ? {} : { usesSoFar: options.usesSoFar }),
    });
    if (!verdict.ok) return { verdict };

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
    // SECURITY: the reducer device id is DERIVED from the proof-bound signing key, NOT
    // taken from the joiner-chosen KeyPackage credential identity (which the joiner fully
    // controls + MLS dedups only by signature key, so a joiner could otherwise collide an
    // existing device_id, desyncing the reducer from MLS and mis-targeting removal).  The
    // joiner set its KeyPackage identity to this SAME derived value (prepareJoinRequest),
    // so `utf8(deviceId)` still resolves the leaf for §10.9 removal.  Fail-closed: reject
    // a KeyPackage whose credential identity does not match the derived id, or a collision
    // with an existing device.
    const newDeviceId = await deviceIdFromSigningKey(this.p2p, verdict.deviceSigningPublicKey);
    const cred = verdict.keyPackage.leafNode.credential;
    const credIdentity = cred.credentialType === 'basic' ? this.p2p.fromUtf8(cred.identity) : '';
    if (credIdentity !== newDeviceId || this.engine.state().devices.has(newDeviceId)) {
      return { verdict: { ok: false, reason: 'malformed_key_package' } };
    }
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
        // dedicated Ed25519 op-signing key (proof-bound in the §12.3 request, so a relay
        // cannot substitute it — and SEPARATE from the MLS leaf key, no cross-protocol
        // reuse) and its HPKE init key (authenticated by the verified KeyPackage).
        signingPublicKey: verdict.deviceSigningPublicKey,
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
    // §10.9: deliver the epoch-rotating commit to every currently-connected member so
    // they advance to the new epoch and can open the new-epoch content (otherwise their
    // engines would quarantine it no_epoch_key).
    this.broadcastCommit(this.p2p.encodeCommit(invited.commit), epoch);

    // Build the joiner's bootstrap GRANT: a §14.5 snapshot sealed under the NEW epoch
    // (the only epoch the joiner holds) carries the FULL reduced state — members,
    // devices, content — so a fresh joiner sees the current room WITHOUT the historical
    // epoch keys it never held (forward secrecy preserved).  commitSnapshot covers the
    // just-applied member.add, so the snapshot already includes the joiner.
    const snapshotBase = await this.engine.commitSnapshot({
      epoch,
      roomEpochSecret: newEpochState.roomEpochSecret,
      contentWrapKey: newEpochState.keys.contentWrapKey,
      author: {
        memberId: this.session.memberId,
        deviceId: this.session.deviceId,
        signingKey: this.session.signingPrivateKey,
      },
      opId: globalThis.crypto.randomUUID(),
      snapshotId: globalThis.crypto.randomUUID(),
    });
    if (snapshotBase) {
      this.session = { ...this.session, snapshotBase };
      await putRoomSession(this.session);
    }
    const archive = await this.engine.exportArchive({
      kind: 'encrypted_member_backup',
      createdAtBucket: coarseBucket(),
    });
    const grant: JoinGrant = {
      welcome: this.p2p.encodeWelcomeMessage(invited.welcome),
      roomId: this.session.roomId,
      roomIdCommitment: this.session.roomIdCommitment,
      manifest: this.session.manifest,
      manifestCommitment: this.session.manifestCommitment,
      assignedMemberId: newMemberId,
      assignedDeviceId: newDeviceId,
      // The current device roster (public keys) — the joiner's bootstrap trust set,
      // authenticated by the admin it is joining through (the §10.3 channel).
      bootstrapDevices: [...this.engine.state().devices.values()]
        .filter((d) => !d.removed)
        .map((d) => ({ deviceId: d.deviceId, signingPublicKey: d.signingPublicKey })),
      archive,
    };
    return { verdict, grant };
  }

  /**
   * §12.3 finish (joiner side) — process the admin's Welcome to join the MLS group at the
   * current epoch, construct a fresh engine bootstrapped from the grant's §14.5 snapshot
   * (so the joiner sees the existing members/devices/content without the historical epoch
   * keys), persist the session, and return it.  The container confers NO trust (§8.3):
   * importArchive re-validates the snapshot against its in-band commit and re-runs the
   * §14.2 pre-pass + openOp on every envelope.
   */
  private static async finishJoin(
    grant: JoinGrant,
    joiner: {
      readonly bundle: KeyPackageBundle;
      readonly signingPrivateKey: CryptoKey;
      readonly signingPublicKey: string;
      readonly hpkePrivateKey: CryptoKey;
      readonly hpkePublicKey: Uint8Array;
      readonly createStorage?: (roomId: string) => PrivateRoomStorage;
    },
  ): Promise<PrivateRoomSession> {
    await ensurePrivateBundleTrusted();
    const p2p = await loadP2p();
    const welcome = p2p.decodeWelcomeMessage(grant.welcome);
    const joined = await p2p.joinRoom({
      welcome,
      bundle: joiner.bundle,
      roomIdCommitment: grant.roomIdCommitment,
      manifestCommitment: grant.manifestCommitment,
    });
    const epochState = joined.epochState;
    const epochNum = Number(epochState.epoch);
    const engine = await p2p.PrivateRoomEngine.load({
      roomId: grant.roomId,
      roomIdCommitment: grant.roomIdCommitment,
      storage:
        joiner.createStorage?.(grant.roomId) ?? new IndexedDbPrivateRoomStorage(grant.roomId),
      epochs: new Map([[epochNum, p2p.heldKeysOf(epochState)]]),
      bootstrapDevices: grant.bootstrapDevices,
    });
    // Bootstrap the current state from the grant's archive (snapshot sealed under the
    // joined epoch + any post-snapshot envelopes), all re-validated.
    await engine.importArchive(grant.archive);
    const base = engine.exportBase();
    const session: StoredRoomSession = {
      roomId: grant.roomId,
      roomIdCommitment: grant.roomIdCommitment,
      memberId: grant.assignedMemberId,
      deviceId: grant.assignedDeviceId,
      signingPrivateKey: joiner.signingPrivateKey,
      signingPublicKey: joiner.signingPublicKey,
      hpkePrivateKey: joiner.hpkePrivateKey,
      hpkePublicKey: joiner.hpkePublicKey,
      mlsGroupState: p2p.serializeGroupState(joined.group),
      epochs: [
        {
          epoch: epochNum,
          roomEpochSecret: epochState.roomEpochSecret,
          contentWrapKey: epochState.keys.contentWrapKey,
        },
      ],
      manifest: grant.manifest,
      manifestCommitment: grant.manifestCommitment,
      bootstrapDevices: grant.bootstrapDevices,
      ...(base ? { snapshotBase: base } : {}),
      createdAtBucket: coarseBucket(),
    };
    await putRoomSession(session);
    return new PrivateRoomSession(p2p, engine, session, DEFAULT_COMPACT_EVERY_OPS);
  }

  /**
   * §10.9 — remove a device: the MLS Remove ROTATES the epoch, the signed
   * `device.remove` op is authored at the NEW epoch (so the evicted device, lacking the
   * new key, cannot read it), the advanced group + new epoch keys are persisted, and the
   * rotating commit is broadcast to connected members (so they advance too).  After this
   * the evicted device's engine quarantines all post-removal content — forward secrecy.
   * `deviceId` is resolved to the MLS leaf via `utf8(deviceId)` (the device-id invariant).
   * Throws if the device is not in the MLS group.
   */
  async removeMember(params: {
    readonly memberId: string;
    readonly deviceId: string;
    readonly reason?: string;
  }): Promise<void> {
    const group = await this.p2p.deserializeGroupState(this.session.mlsGroupState);
    const removed = await this.p2p.removeDeviceFromRoom(group, this.p2p.utf8(params.deviceId));
    const newEpochState = await this.p2p.deriveEpochState(
      removed.group,
      this.session.roomIdCommitment,
      this.session.manifestCommitment,
    );
    const epoch = Number(newEpochState.epoch);
    this.engine.addEpochKeys(epoch, this.p2p.heldKeysOf(newEpochState));
    const { op, sealParams } = await this.p2p.buildRoomOp(
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
        type: 'device.remove',
        member_id: params.memberId,
        device_id: params.deviceId,
        ...(params.reason === undefined ? {} : { reason: params.reason }),
      },
    );
    await this.engine.applyLocalOp(op, sealParams);
    this.session = {
      ...this.session,
      mlsGroupState: this.p2p.serializeGroupState(removed.group),
      epochs: [
        ...this.session.epochs.filter((e) => e.epoch !== epoch),
        {
          epoch,
          roomEpochSecret: newEpochState.roomEpochSecret,
          contentWrapKey: newEpochState.keys.contentWrapKey,
        },
      ],
    };
    await putRoomSession(this.session);
    this.broadcastCommit(this.p2p.encodeCommit(removed.commit), epoch);
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
