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
import { canonicalRegistrationProofBytes } from '@licio/shared';
import type { StoredDirectoryStub } from './session-store.js';

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

/*
 * The §21 directory capability is DELIBERATELY not a grant field.
 *
 * It rode here for one round and that was wrong. A grant is copy-pasted over an
 * out-of-band channel and only the Welcome and the archive are cryptographically
 * protected — everything else in the blob is plaintext to anyone who sees the
 * message. `bootstrap_blind_id` does not rotate, so an observer would keep a
 * capability that resolves an `unlisted` record forever, including after it is
 * delisted, which is the state delisting exists to produce.
 *
 * The joiner does not need it there. It rides the HPKE-SEALED invite (§10.3),
 * which the joiner has already opened by the time a grant exists, so
 * `prepareJoinRequest` retains it from that invite and hands it to `finishJoin`
 * directly. One sealed delivery, no plaintext copy.
 */

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

import { isUpdateChannelConfigured } from '../update/config.js';
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
  type SyncEngineSurface,
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
  if (!isUpdateChannelConfigured()) return;
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * The §12.1 genesis founder device id to pin the reducer with — ONLY when the
 * manifest is authentic, i.e. its computed §13.1 commitment matches the
 * (crypto-bound) `manifestCommitment`.  A forged or mismatched manifest yields
 * `undefined` (no pin), so a bad `founder` field can never mis-pin the genesis; the
 * joiner remains protected by folding from the verified archive base regardless.
 */
async function verifiedFounderDeviceId(
  p2p: P2pModule,
  manifest: unknown,
  manifestCommitment: Uint8Array,
): Promise<string | undefined> {
  const parsed = p2p.privateRoomManifestSchema.safeParse(manifest);
  if (!parsed.success) return undefined;
  const computed = await p2p.computeManifestCommitment(parsed.data);
  return bytesEqual(computed, manifestCommitment) ? parsed.data.founder.device_id : undefined;
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
export function manifestRoomPublicKey(manifest: unknown): string | undefined {
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
   *  every currently-connected member).  Closed sessions are pruned promptly via `onTerminate`
   *  and defensively during the next broadcast. */
  private readonly activeSessions = new Set<PrivateSyncSession>();
  /** The handshake-PROVEN remote device id of each live session (when known — a live WebRTC carrier),
   *  so `removeMember` can tear down an EVICTED device's session BEFORE re-announcing post-removal
   *  heads to it (else the evicted peer keeps requesting + being served post-removal ciphertext +
   *  metadata over its still-open channel until it happens to drop, PRIV-WEB-SESSION-EVICT). */
  private readonly sessionPeerDevice = new WeakMap<PrivateSyncSession, string>();

  /**
   * Serializes EVERY MLS-group / epoch-key / engine-state mutation (PRIV-WEB-SESSION-2).  A peer's
   * incoming `mls_commit` is handled asynchronously off the sync session, so without this it could
   * interleave with a local `authorOp` / `admitJoinRequest` / `removeMember` / `ingest`: two
   * read-modify-writes of `this.session` (the MLS group + epoch keys) and the shared, non-re-entrant
   * engine state would race — a lost `removeMember` (an evicted device keeps reading → weakened
   * forward secrecy), a divergent epoch, or a corrupted fold.  Tail-chained: each critical section
   * runs after the prior SETTLES; a rejection is swallowed in the chain so it cannot wedge the lock,
   * while the CALLER of the failing op still receives its rejection.
   */
  private opLock: Promise<void> = Promise.resolve();
  private runExclusive<T>(critical: () => Promise<T>): Promise<T> {
    const result = this.opLock.then(() => critical());
    this.opLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get roomId(): string {
    return this.session.roomId;
  }
  get memberId(): string {
    return this.session.memberId;
  }
  get deviceId(): string {
    return this.session.deviceId;
  }
  /**
   * This device's Ed25519 signing public key — what the §8.2 stub publishes as
   * `room_public_key`, and therefore how a client identifies its OWN directory
   * record among the ones its account owns.
   *
   * Exposed separately from `directoryStubPayload()` because reading it cannot
   * fail: the recovery path needs it precisely when deriving the full payload
   * did fail.
   */
  get signingPublicKey(): string {
    return this.session.signingPublicKey;
  }
  /**
   * The room's §13.1 manifest commitment, base64url.
   *
   * Separate from `directoryStubPayload()` on purpose: refreshing
   * `latest_manifest_commitment` is §21.3-patchable WITHOUT re-signing anything,
   * and the payload builder needs the GENESIS epoch to derive the capability —
   * so routing the refresh through it made a plain column update impossible on
   * every device that joined later.
   */
  get manifestCommitmentB64(): string {
    return this.p2p.toBase64Url(this.session.manifestCommitment);
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
      /** The handshake-PROVEN remote device id (a live WebRTC carrier), so an eviction can tear this
       *  session down before re-announcing to it (PRIV-WEB-SESSION-EVICT).  Omitted for a carrier with
       *  no device identity (an offline-archive relay / a test loopback). */
      readonly peerDeviceId?: string;
    },
  ): PrivateSyncSession {
    const codec: SyncCodec = {
      encodeSyncMessage: this.p2p.encodeSyncMessage,
      decodeSyncMessage: this.p2p.decodeSyncMessage,
      chunkOpResponse: this.p2p.chunkOpResponseEnvelopes,
    };
    const { peerDeviceId, ...sessionOptions } = options ?? {};
    let sync: PrivateSyncSession;
    // PRIV-WEB-SESSION-3: the session must drive the engine through the manager's `runExclusive`
    // lock, NOT the raw engine.  A `PrivateSyncSession` has its OWN per-session message queue, but
    // that only orders messages WITHIN one session — it does NOT serialize a peer's `ingest` /
    // `importArchive` / `ingestBlocks` against a local `authorOp` / `removeMember` /
    // `admitJoinRequest` / an incoming MLS commit (each on the manager's `opLock`) OR against
    // ANOTHER active session in a mesh.  Passing the raw engine left those engine-state mutations
    // interleaving on the non-re-entrant engine (a corrupted fold / lost remove / divergent epoch).
    sync = new PrivateSyncSession(this.lockedEngineSurface(), channel, codec, {
      ...sessionOptions,
      // The manager owns §10.9 commit application (it holds the MLS group); a peer's
      // commit advances THIS device's epoch + re-opens the pending content.
      onMlsCommit: (commit, epoch) => this.applyIncomingCommit(commit, epoch),
      // Prune the session from `activeSessions` (+ its device mapping) the moment it ends by ANY path —
      // an external channel drop OR a controller/UI `close()` (PRIV-WEB-SESSION-1: the set would
      // otherwise grow unbounded across every reconnect).  Fires once; the closure captures `sync`
      // (assigned below, before any terminate can fire).
      onTerminate: () => {
        this.activeSessions.delete(sync);
        this.sessionPeerDevice.delete(sync);
      },
    });
    this.activeSessions.add(sync);
    if (peerDeviceId !== undefined) this.sessionPeerDevice.set(sync, peerDeviceId);
    sync.start();
    return sync;
  }

  /**
   * Tear down every live session whose handshake-proven remote device id is `deviceId` (an EVICTED
   * device): `close()` stops its message pump so it can no longer request or be served ops, and closes
   * the underlying channel.  Called by `removeMember` BEFORE re-announcing so post-removal heads /
   * content never reach the evicted peer (PRIV-WEB-SESSION-EVICT).
   */
  private closeSessionsForDevice(deviceId: string): void {
    for (const session of [...this.activeSessions]) {
      if (this.sessionPeerDevice.get(session) === deviceId) session.close();
    }
  }

  /**
   * The §15.6/§15.7 engine surface a live `PrivateSyncSession` drives, with EVERY async (await-
   * crossing) engine call routed through the manager's `runExclusive` lock (PRIV-WEB-SESSION-3).
   * The MUTATING calls (`ingest` for `op_response`, `importArchive` for a snapshot response,
   * `ingestBlocks` for a block response) are the integrity hazard — without the lock they
   * interleave with a local `authorOp` / `removeMember` / `admitJoinRequest` / an incoming MLS
   * commit (and with other mesh sessions) on the non-re-entrant engine.  The async SERVE reads
   * (`serveOps` / `serveBlocks` / `snapshotArchive` / `wantedBlockCids`) are serialized too so a
   * serve never reads a half-applied fold.  The five SYNCHRONOUS reads (`headAnnouncement` /
   * `wantedFrom` / `missingDependencies` / `latestSnapshotId` / `pendingCount`) run to completion with
   * no await, so no mutation can interleave mid-call — they pass through unlocked.  Each session
   * handler makes at most ONE async engine call, so there is no nested-lock acquisition (the lock is
   * non-re-entrant).
   */
  private lockedEngineSurface(): SyncEngineSurface {
    const engine = this.engine;
    return {
      headAnnouncement: (latestSnapshotId) => engine.headAnnouncement(latestSnapshotId),
      wantedFrom: (announcement) => engine.wantedFrom(announcement),
      missingDependencies: () => engine.missingDependencies(),
      latestSnapshotId: () => engine.latestSnapshotId(),
      // §14.5 stuck-detection (PRIV-SESSION-SNAPSHOT-STUCK): a pure Map-size read, so it joins the
      // synchronous-reads group (no await ⇒ no mutation interleaves).  Omitting it silently disabled
      // the snapshot bootstrap for a compacted-prefix peer — now REQUIRED on the surface.
      pendingCount: () => engine.pendingCount(),
      serveOps: (opIds) => this.runExclusive(() => engine.serveOps(opIds)),
      ingest: (envelopes) => this.runExclusive(() => engine.ingest(envelopes)),
      wantedBlockCids: () => this.runExclusive(() => engine.wantedBlockCids()),
      serveBlocks: (cids, maxBytes) => this.runExclusive(() => engine.serveBlocks(cids, maxBytes)),
      ingestBlocks: (blocks) => this.runExclusive(() => engine.ingestBlocks(blocks)),
      snapshotArchive: () => this.runExclusive(() => engine.snapshotArchive()),
      importArchive: (bytes) => this.runExclusive(() => this.importArchiveImpl(bytes)),
    };
  }

  /**
   * Run `importArchive` on the engine and PERSIST the resulting base.  A live sync-session snapshot
   * ADOPTION (§14.5 rebase) — or an offline-archive import — rebases the engine's `sealedSnapshot` in
   * memory, but a reload re-seeds the engine from `StoredRoomSession.snapshotBase`, which the manager
   * updates after local compaction/admission but NOT after an import.  Without persisting, an app
   * restart before the next local compaction falls back to the OLD base while the ops the peer snapshot
   * summarizes may already be pruned, so the room LOSES the catch-up and re-strands on the same
   * compacted prefix (PRIV-WEB-SNAPSHOT-PERSIST).  `exportBase()` returns the engine's CURRENT base, so
   * persisting it is correct whether the import adopted a newer snapshot, kept ours, or added only ops.
   * Runs under the op-lock (called from within `runExclusive`, like `ingest`), so the persisted base
   * reflects the imported state atomically.
   */
  private async importArchiveImpl(bytes: Uint8Array): Promise<IngestReport> {
    const report = await this.engine.importArchive(bytes);
    const base = this.engine.exportBase();
    if (base !== undefined) {
      this.session = { ...this.session, snapshotBase: base };
      await putRoomSession(this.session);
    }
    return report;
  }

  /**
   * §10.9 — apply an MLS Commit received from a peer over a live session: advance THIS
   * device's MLS group to the new epoch, derive + install the new epoch keys, re-open the
   * content that was pending on that key, and persist the advanced group + keys.  The
   * sync session then re-announces + walks the newly-decryptable frontier.  Fail-closed:
   * a bad commit throws (applyCommit), leaving the group/keys untouched.
   */
  private applyIncomingCommit(commit: Uint8Array, epoch: number): Promise<void> {
    return this.runExclusive(() => this.applyIncomingCommitImpl(commit, epoch));
  }

  private async applyIncomingCommitImpl(commit: Uint8Array, epoch: number): Promise<void> {
    const group = await this.p2p.deserializeGroupState(this.session.mlsGroupState);
    // §11.3 AUTHORITY GATE (PRIV-CRYPTO-1): an MLS commit only advances THIS device's epoch when its
    // committer is a current, non-removed device whose member holds the `admin` capability in the
    // converged reduced state.  RFC 9420 has no admin role — without this, any handshake-authenticated
    // member could commit an Add of a ghost reader device (which would then derive the new
    // content_wrap_key) or a Remove of an honest admin, and we would blindly install the new epoch
    // keys.  A rejected commit throws (below), leaving the group/keys untouched (fail-closed).
    const advanced = await this.p2p.applyCommit(
      group,
      this.p2p.decodeCommit(commit),
      (committerDeviceId) =>
        this.p2p.deviceMayManageMembership(this.engine.state(), committerDeviceId),
    );
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
    for (const session of this.activeSessions) {
      // Defence-in-depth prune (PRIV-WEB-SESSION-1): drop any already-closed session encountered
      // here too, so the set self-heals even if a teardown path ever bypassed `onTerminate`.
      if (session.isClosed()) {
        this.activeSessions.delete(session);
        continue;
      }
      session.sendMlsCommit(commit, epoch);
    }
  }

  /** §15.6 — after a LOCAL author (a new op / an admitted or removed member), nudge every live
   *  session to re-announce its heads so each connected peer PULLS the new ops.  Without this a live
   *  session (1:1 or mesh) converges only the state that existed at connect time — a subsequently
   *  authored op (a story, a `member.add`/`member.remove`, a cap op) would never propagate until a
   *  reconnect.  Self-heals the set on a stale/closed session, mirroring `broadcastCommit`. */
  private nudgeActiveSessions(): void {
    for (const session of this.activeSessions) {
      if (session.isClosed()) {
        this.activeSessions.delete(session);
        continue;
      }
      session.reannounce();
    }
  }

  /**
   * Ingest envelopes delivered out-of-band (a peer push, an imported archive) through
   * the engine's verify-before-use path (§8.3).  Returns what was accepted vs.
   * quarantined so a UI can surface sync/quarantine status.
   */
  async ingest(envelopes: readonly PrivateEncryptedEnvelope[]): Promise<IngestReport> {
    // The engine-state mutation is serialized with applyIncomingCommit / authorOp (PRIV-WEB-SESSION-2).
    const report = await this.runExclusive(() => this.engine.ingest(envelopes));
    // Advance the Tier-2 cap (publish/install/issue) after new ops land; fail-open to Tier-1.  This
    // runs OUTSIDE the op-lock — `syncCap` calls `authorOp`, which acquires the lock ITSELF, so
    // holding it here would re-entrantly deadlock.
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
    // Serialized on the manager's op-lock, symmetric with `ingest` (PRIV-WEB-SESSION-2/3): an
    // out-of-band archive import is an engine-state mutation and must not interleave with a local
    // authoring op, an incoming MLS commit, or a live sync session's fold on the non-re-entrant engine.
    // Persists the resulting snapshot base so a reload keeps the catch-up (PRIV-WEB-SNAPSHOT-PERSIST).
    return this.runExclusive(() => this.importArchiveImpl(bytes));
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
   * Record the §21 directory stub this room registered.
   *
   * The server mints `room_server_id` at create time and it is the ONLY handle
   * for every later bootstrap, patch, delist and delete — there is no endpoint
   * that lists an account's stubs. Discarding it would leave the record
   * unreachable and unmanageable, so the caller persists it here the moment
   * registration succeeds.
   */
  async attachDirectoryStub(stub: {
    readonly roomServerId: string;
    /** Derived from the room's EPOCH-0 rendezvous key — see the field's note on
     *  `StoredRoomSession`. Stored because later members cannot re-derive it. */
    readonly bootstrapBlindId: string;
  }): Promise<void> {
    // VERIFIED by provenance: this device just registered the record and holds
    // the room key that signed it, so there is nothing to check it against that
    // it did not produce. A handle that arrives from someone else takes the
    // other path (`finishJoin`) and starts unverified.
    this.session = { ...this.session, directoryStub: { capability: stub, verified: true } };
    await putRoomSession(this.session);
  }

  /**
   * Release an invite-carried handle after it has been CHECKED against this room.
   *
   * The counterpart to `quarantineDirectoryStub`: verification has two outcomes
   * and both have to be recorded, or "not yet checked" and "checked and fine"
   * stay indistinguishable — which is exactly what let an unverified handle
   * travel in invites.
   */
  async markDirectoryStubVerified(): Promise<void> {
    const stored = this.session.directoryStub;
    if (stored === undefined || stored.verified === true) return;
    const { quarantined: _cleared, ...rest } = stored;
    this.session = { ...this.session, directoryStub: { ...rest, verified: true } };
    await putRoomSession(this.session);
  }

  /**
   * Forget the §21 directory record — after a successful DELETE.
   *
   * Without this the handle outlives the record: reloading the room reads a
   * deleted stub, keeps offering actions against it, and — worse — the next
   * admit copies the dead capability into a joiner's grant, so a new member
   * inherits a handle whose first use is a 404 they cannot explain. The record
   * is gone; the pointer to it must go with it.
   */
  async clearDirectoryStub(): Promise<void> {
    if (this.session.directoryStub === undefined) return;
    const { directoryStub: _dropped, ...rest } = this.session;
    this.session = rest;
    await putRoomSession(this.session);
  }
  /**
   * Mark the stored handle as pointing at ANOTHER room.
   *
   * Called when the post-join verification fails: the record the handle opens is
   * not signed by this room, so it was never this room's. Kept rather than
   * deleted — the member is told, and can forget it deliberately — but it stops
   * travelling in invites the moment it is set.
   */
  async quarantineDirectoryStub(): Promise<void> {
    const stored = this.session.directoryStub;
    if (stored === undefined || stored.quarantined === true) return;
    // …and REVOKE the release with it. Verification is now a positive fact that
    // invites require, so a handle that fails a later check has to lose it —
    // otherwise a record that verified once and was re-checked after the room
    // moved would keep travelling on the strength of the old answer.
    this.session = {
      ...this.session,
      directoryStub: { ...stored, quarantined: true, verified: false },
    };
    await putRoomSession(this.session);
  }

  /**
   * Can this device derive the room's §21.2 capability?
   *
   * Only a device holding the GENESIS epoch can: the blind id is bound to
   * epoch-0's rendezvous key, and forward secrecy means a joined device never
   * receives it. Registration surfaces ask before offering the action, so a
   * member is not walked into a signature that cannot produce a valid record.
   */
  get canRegisterDirectory(): boolean {
    return this.session.epochs.some((entry) => entry.epoch === 0);
  }

  /**
   * Verify a §21 directory record against the room's OWN key before believing it.
   *
   * "Signed by the room" was a property nothing checked. The server stores
   * `signed_stub` verbatim and cannot verify it (it holds no room key), so the
   * signature is worth exactly as much as the client's willingness to read it —
   * and until now no client did, which made the identity guarantee, and the
   * refusal that preserves it, decoration.
   *
   * Two things are checked, and both are necessary. The signature must verify
   * over the CANONICAL encoding of the body, and `room_public_key` must be the
   * founder device's signing key as this session knows it — otherwise a
   * substituted record signed by an attacker's key verifies against itself
   * perfectly.
   *
   * Fail closed: anything unparseable, unknown or mismatched is `false`.
   */
  async verifyDirectoryRecord(
    signedStub: Record<string, unknown>,
    stubSignature: string,
  ): Promise<boolean> {
    // Re-shape to the CLOSED §8.2 body before canonicalizing. The wire type is
    // `Record<string, unknown>`, and canonical encoding of an arbitrary object
    // is not defined — nor should a body with an unexpected key verify, since
    // the signature was produced over the closed set.
    const schema = signedStub['schema'];
    const claimed = signedStub['room_public_key'];
    const manifest = signedStub['manifest_key_commitment'];
    if (typeof claimed !== 'string' || typeof manifest !== 'string') return false;
    // BOTH shapes verify.
    //
    // A record written before the capability moved to its own column carries the
    // v1 body, and migration `0120` preserves those bytes exactly — the server
    // holds no room key and cannot re-sign, so rewriting them would have made
    // every existing record unverifiable. The v1 body is served only to a caller
    // holding the capability (it contains one), which is why a member can still
    // check it and a stranger never sees it.
    //
    // Reconstructed field by field rather than canonicalizing the received
    // object: a body with an unexpected key must not verify, because the
    // signature was produced over a closed set.
    const legacyToken = signedStub['bootstrap_blind_id'];
    const canonicalBody =
      schema === 'licio.private.directory_stub.v2'
        ? Object.keys(signedStub).length === 3
          ? ({ schema, room_public_key: claimed, manifest_key_commitment: manifest } as const)
          : null
        : schema === 'licio.private.directory_stub.v1' &&
            Object.keys(signedStub).length === 4 &&
            typeof legacyToken === 'string'
          ? ({
              schema,
              room_public_key: claimed,
              manifest_key_commitment: manifest,
              bootstrap_blind_id: legacyToken,
            } as const)
          : null;
    if (canonicalBody === null) return false;
    // The founder's signing key, from the roster this session was bootstrapped
    // with — the same set `PrivateRoomEngine.load` verifies the genesis self-add
    // against, so it is the room's own answer rather than the record's.
    const founderDeviceId = await verifiedFounderDeviceId(
      this.p2p,
      this.session.manifest,
      this.session.manifestCommitment,
    );
    if (founderDeviceId === undefined) return false;
    // The room's OWN converged device roster, which retains removed devices —
    // not the grant's bootstrap set, which excludes them. A founder device that
    // has since been removed still signed the record, and rejecting it would
    // make a valid record read as forged to every member who joined afterwards.
    const founder =
      this.engine.state().devices.get(founderDeviceId) ??
      this.session.bootstrapDevices.find((device) => device.deviceId === founderDeviceId);
    if (founder === undefined || founder.signingPublicKey !== claimed) return false;
    try {
      const key = await this.p2p.importPublicKeyRaw(this.p2p.fromBase64Url(claimed));
      return await this.p2p.verifyEd25519(
        key,
        this.p2p.canonical(canonicalBody),
        this.p2p.fromBase64Url(stubSignature),
      );
    } catch {
      return false;
    }
  }

  /** The §21 directory record for this room, if it registered one. */
  get directoryStub(): StoredRoomSession['directoryStub'] {
    return this.session.directoryStub;
  }

  /**
   * Build the SIGNED body of this room's §8.2 directory stub (PRIVATE_SPEC
   * §21.1), for a creator who wants the room reachable by id rather than only
   * by out-of-band invite.
   *
   * Everything it publishes is a COMMITMENT the room already stands behind —
   * the founder device's signing public key, the manifest commitment, and (for
   * an `unlisted` room) a bootstrap blind id.  No key material, no content, no
   * member, no operation head.  The body is canonically encoded and Ed25519-
   * signed by this device, so any member can verify the directory record was
   * authored by the room rather than by the server that stores it — which is
   * the whole reason the server keeps `signed_stub` verbatim instead of
   * interpreting it.
   *
   * The bootstrap blind id is NOT part of the signed body.  Signing it bought
   * nothing — the signature is verified against `room_public_key`, which the
   * body itself carries, so it only means something to a reader who already
   * knows the room's key independently — while placing it there put a SECRET
   * inside the one structure the server hands to anonymous readers.  What the
   * capability needs is secrecy, which no signature provides.
   *
   * It is derived from the room's epoch-0 rendezvous key
   * through a labeled HKDF, so unlike the §15.3 rendezvous blind ids it does
   * NOT rotate: an invite handed out today must still resolve the record
   * tomorrow, and after the next membership change.  The cost is that a removed
   * member keeps a token that resolves a record of commitments and policy — no
   * content, no keys, and nothing they did not already know, since they were in
   * the room.  Rotating it would break every outstanding invite to protect
   * information the ex-member already has.
   */
  async directoryStubPayload(accountId?: string): Promise<{
    readonly roomPublicKey: string;
    readonly manifestKeyCommitment: string;
    readonly signedStub: Record<string, unknown>;
    readonly stubSignature: string;
    readonly bootstrapBlindId: string;
    /** Present when an `accountId` was given — registration needs it, and the
     *  invite path (which only reads the capability) does not. */
    readonly registrationProof?: string;
  }> {
    // The GENESIS epoch specifically, found by number rather than by position.
    //
    // `epochs[0]` is the first epoch this DEVICE holds, which for a founder is
    // epoch 0 and for a joiner is whatever epoch it was admitted at — §11
    // forward secrecy means a joiner never receives the earlier keys. Reading
    // position zero and calling it genesis therefore derived a bootstrap blind
    // id from the wrong key on every joined device: a capability no other member
    // can reproduce, for a record members are meant to share.
    //
    // Fail closed rather than deriving something. A device that cannot produce
    // the room's canonical capability must not publish a record claiming to be
    // the room's — the caller offers the action only where it can succeed.
    const genesis = this.session.epochs.find((entry) => entry.epoch === 0);
    if (!genesis) {
      throw new Error(
        'private-p2p: this device does not hold the room genesis epoch, so it cannot derive the §21.2 bootstrap capability',
      );
    }
    const keys = await this.p2p.deriveRoomEpochKeys(
      genesis.roomEpochSecret,
      this.session.roomIdCommitment,
    );
    const bootstrapBlindId = this.p2p.toBase64Url(
      await this.p2p.hmacSha256(
        keys.rendezvousKey,
        this.p2p.canonical(['licio.private.bootstrap.v1', this.session.roomIdCommitment]),
      ),
    );
    const roomPublicKey = this.session.signingPublicKey;
    const manifestKeyCommitment = this.p2p.toBase64Url(this.session.manifestCommitment);
    // Declared as canonical-encodable rather than `Record<string, unknown>` so
    // the SIGNED bytes and the transmitted object cannot drift: a field the
    // encoder would reject is a compile error here, not a signature every
    // member fails to verify.
    // EXACTLY the server's closed §8.2 field set — no more, no less. The wire
    // schema is `.strict()`, so an extra key here is a 400 rather than a
    // silently-persisted one; that is the point, since "signed by the room" is
    // not a safety property the server can check (it holds no room key).
    // PUBLIC commitments only. The bootstrap capability is returned ALONGSIDE
    // this body and sent as its own field: the server keeps it in a column it
    // never projects, because a jsonb body is disclosed wholesale wherever it is
    // disclosed at all — and a `listed` room's bootstrap read is open to anyone.
    const signedStub = {
      schema: 'licio.private.directory_stub.v2',
      room_public_key: roomPublicKey,
      manifest_key_commitment: manifestKeyCommitment,
    } as const satisfies Record<string, string>;
    const stubSignature = this.p2p.toBase64Url(
      await this.p2p.signEd25519(this.session.signingPrivateKey, this.p2p.canonical(signedStub)),
    );
    // …and a proof of CURRENT possession, bound to the account registering.
    //
    // The signature above covers a body that is SERVED — publicly for a listed
    // record, to every invitee for an unlisted one — so replaying it says only
    // that the replayer has seen a record. This one covers the account too, is
    // never stored and never served, and is what stops an observer claiming the
    // room's key after the owner removes their record.
    const registrationProof =
      accountId === undefined
        ? undefined
        : this.p2p.toBase64Url(
            await this.p2p.signEd25519(
              this.session.signingPrivateKey,
              canonicalRegistrationProofBytes({
                room_public_key: roomPublicKey,
                manifest_key_commitment: manifestKeyCommitment,
                account_id: accountId,
              }),
            ),
          );
    return {
      roomPublicKey,
      manifestKeyCommitment,
      signedStub,
      stubSignature,
      bootstrapBlindId,
      ...(registrationProof === undefined ? {} : { registrationProof }),
    };
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
    const { channel, peerDeviceId } = await connectPrivatePeer({
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
      peerDeviceId, // the handshake-proven id, so an eviction tears this session down (PRIV-WEB-SESSION-EVICT)
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
        peerDeviceId: result.peerDeviceId, // so an eviction tears this mesh session down (PRIV-WEB-SESSION-EVICT)
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
    // The §12.1 genesis founder pin — the manifest-committed founder device (the
    // only identity permitted to bootstrap the room), accepted ONLY if the persisted
    // manifest still verifies against its commitment.  A pre-`founder` or tampered
    // manifest leaves it undefined, falling back to the legacy rule.
    const genesisFounderDeviceId = await verifiedFounderDeviceId(
      p2p,
      session.manifest,
      session.manifestCommitment,
    );
    // FAIL CLOSED on genesis integrity: without a verified §14.5 base the reducer
    // folds from EMPTY, so the founder pin is the ONLY thing stopping a bootstrap
    // co-member from forging a lower-Lamport `member.add` as the genesis. If the
    // founder commitment cannot be verified (tampered/undecodable persisted manifest)
    // AND there is no base to fold from, refuse to load rather than adopt an unpinned
    // genesis. (A verified base already bakes the real genesis in, so the pin is moot
    // there — availability over strictness for the display-only manifest fields still
    // holds whenever a base is present.)
    if (genesisFounderDeviceId === undefined && session.snapshotBase === undefined) {
      throw new Error(
        `private-p2p: room ${roomId} founder commitment failed verification and no snapshot base — refusing to load an unpinned genesis (WS-S §12.1)`,
      );
    }
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
      ...(genesisFounderDeviceId ? { genesisFounderDeviceId } : {}),
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

  /** Forget a room locally (does not touch other members).  Purges EVERY local
   *  trace: the room's envelopes, media blocks, Tier-2 cap secrets, and
   *  invite-use counters (deleteAllForRoom), then the session row — leaving no
   *  orphaned ciphertext or secrets behind. */
  static async leave(roomId: string): Promise<void> {
    await new IndexedDbPrivateRoomStorage(roomId).deleteAllForRoom();
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
  authorOp(body: PrivateOpBodyInput): Promise<void> {
    return this.runExclusive(() => this.authorOpImpl(body));
  }

  private async authorOpImpl(body: PrivateOpBodyInput): Promise<void> {
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
        parents: this.engine.heads(),
        lamport: this.engine.nextLamport(),
      },
      body,
    );
    await this.engine.applyLocalOp(op, sealParams);
    await this.persistCompactionIfDue();
    // Push the freshly-authored head to every live peer (mesh or 1:1) — a quiescent session does not
    // otherwise learn about locally-authored ops (PRIV-WEB-SESSION-NUDGE).
    this.nudgeActiveSessions();
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
    // The §21 directory capability rides the SEALED invite, not just the
    // post-admission grant. An invitee needs it BEFORE joining: an `unlisted`
    // record answers `not_found` without the token, so without this the
    // recipient of an invite cannot check what Licio publishes about the room
    // they are about to enter — and the room-signed `room_public_key` in that
    // record is the one cross-check on the invite that does not come from the
    // person who sent it.
    // …unless it is QUARANTINED. A handle that failed verification against THIS
    // room points at another one, and copying it into an invite is how a
    // poisoned reference spreads through honest members — the next admin hands
    // it to everyone they invite. It travels only after it has verified.
    // …and only once it HAS verified. `quarantined !== true` was the test, which
    // reads "nobody has proved this wrong yet" as permission — and a handle from
    // someone else's invite is unproved at the moment it is stored, while the
    // check that would prove it runs asynchronously in a panel this admin need
    // never open. Travel requires the positive fact.
    const stored = this.session.directoryStub;
    const stub = stored?.verified === true ? stored.capability : undefined;
    const invite = this.p2p.createRoomInvite({
      roomPublicKey,
      grantedRole: params.grantedRole ?? 'member',
      expiresAt,
      ...(params.maxUses === undefined ? {} : { maxUses: params.maxUses }),
      ...(stub
        ? {
            directory: {
              roomStubRef: stub.roomServerId,
              bootstrapBlindId: stub.bootstrapBlindId,
            },
          }
        : {}),
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
    /**
     * Capabilities retained from opened invites, keyed by the room they are FOR.
     *
     * A map rather than a variable: one preparation can open invites for two
     * rooms, and a single slot meant the most recent one won — so a delayed
     * grant for the first room would persist the SECOND room's token, after
     * which settings address the wrong record and future invites hand that
     * unrelated capability out. The key is the invite's `room_public_key`, which
     * the grant's own manifest carries, so the match is exact rather than
     * positional.
     */
    const directoryByRoomKey = new Map<
      string,
      { capability: StoredDirectoryStub['capability']; ambiguous: boolean }
    >();
    return {
      inviteePublicKey,
      async complete(sealedInvite: string) {
        const invite = await p2p.openInvite(hpke.privateKey, hpke.publicKey, sealedInvite);
        // RETAIN the §21 capability from the sealed invite. It is the only
        // delivery of it this device gets, and the only one that is encrypted to
        // this device — the grant that follows is plaintext on an out-of-band
        // channel.
        if (invite.room_stub_ref !== undefined && invite.bootstrap_blind_id !== undefined) {
          const capability = {
            roomServerId: invite.room_stub_ref,
            bootstrapBlindId: invite.bootstrap_blind_id,
          };
          // TWO invites for the SAME room are indistinguishable to the grant.
          //
          // A grant carries the room's manifest, not the invite it answers, and
          // one preparation uses one KeyPackage for all of them — so when two
          // invites for one room disagree about the record (a stale invite from
          // before the record was removed and registered again), nothing here
          // can tell which grant belongs to which. Last-write-wins silently
          // attached the other invite's handle, and that handle then travels
          // into every invite this device makes.
          //
          // Agreement is the common case and is not a conflict. Disagreement
          // fails CLOSED: the session takes no handle, and the panel can attach
          // the right one deliberately — a room addressed by the wrong record is
          // worse than one addressed by none.
          const seen = directoryByRoomKey.get(invite.room_public_key);
          const conflicts =
            seen !== undefined &&
            (seen.capability.roomServerId !== capability.roomServerId ||
              seen.capability.bootstrapBlindId !== capability.bootstrapBlindId);
          directoryByRoomKey.set(invite.room_public_key, {
            // FIRST wins where they agree (the value is identical anyway); once
            // ambiguous, always ambiguous — a third agreeing invite does not
            // resolve which of the first two a grant answers.
            capability: seen?.capability ?? capability,
            ambiguous: seen?.ambiguous === true || conflicts,
          });
        }
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
        // Match the grant to the invite it answers, by the room key the grant's
        // MANIFEST carries. An unmatched grant simply gets no capability — a
        // wrong one would point this room's settings at another room's record.
        const roomKey = manifestRoomPublicKey(grant.manifest);
        const retained = roomKey === undefined ? undefined : directoryByRoomKey.get(roomKey);
        // Ambiguous ⇒ NONE. See the retention above: a wrong record is worse
        // than no record, because it propagates.
        const directory = retained?.ambiguous === false ? retained.capability : undefined;
        return PrivateRoomSession.finishJoin(grant, {
          bundle: keyPackage,
          signingPrivateKey: signing.privateKey,
          signingPublicKey: deviceSigningPublicKey,
          hpkePrivateKey: hpke.privateKey,
          hpkePublicKey: hpke.publicKey,
          ...(params.createStorage ? { createStorage: params.createStorage } : {}),
          ...(directory ? { directory } : {}),
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
  admitJoinRequest(
    invite: InviteSecret,
    request: JoinRequest,
    options?: { readonly usesSoFar?: number; readonly now?: Date },
  ): Promise<AdmitResult> {
    return this.runExclusive(() => this.admitJoinRequestImpl(invite, request, options));
  }

  private async admitJoinRequestImpl(
    invite: InviteSecret,
    request: JoinRequest,
    options?: { readonly usesSoFar?: number; readonly now?: Date },
  ): Promise<AdmitResult> {
    // CLAIM the §10.3 budget before anything else, in ONE conditional write.
    //
    // Reading the counter here and charging it at the end is a check, not a
    // budget. `runExclusive` is a per-INSTANCE mutex, so the same room open in
    // two tabs gives two managers that never see each other: both read
    // `usesSoFar = 0` on a single-use invite, both pass this gate, both add a
    // member through their own MLS commit, and the room acquires two members on
    // one use plus a pair of divergent branches. The claim is a compare-and-set
    // inside an IndexedDB readwrite transaction, which is shared across tabs.
    //
    // `options.usesSoFar` still wins when a caller supplies it (tests /
    // alternate drivers): that caller owns the accounting, so nothing is
    // claimed and the charge stays where it was.
    const inviteStore = new IndexedDbPrivateRoomStorage(this.session.roomId);
    const driverOwnsBudget = options?.usesSoFar !== undefined;
    let claimed: number | null = null;
    if (!driverOwnsBudget) {
      claimed = await inviteStore.claimInviteUse(invite.invite_id, invite.max_uses);
      if (claimed === null) return { verdict: { ok: false, reason: 'exhausted' } };
    }
    // The claim already took this use, so verification sees the budget as it
    // stood BEFORE it — every other rejection (expiry, proof, key package) is
    // unchanged, and a rejection releases the claim below.
    const usesSoFar = options?.usesSoFar ?? (claimed as number) - 1;
    const verdict = await this.p2p.verifyJoinRequest(invite, request, {
      now: options?.now ?? new Date(),
      usesSoFar,
    });
    if (!verdict.ok) {
      if (claimed !== null) await inviteStore.releaseInviteUse(invite.invite_id);
      return { verdict };
    }

    // A CLAIM WHOSE ADMISSION DOES NOT COMPLETE IS HANDED BACK. Everything below
    // can throw — MLS operations, the engine, the session write — and the use is
    // already taken, so without this a transient failure would silently spend a
    // single-use invite and leave the invitee with nothing to retry against.
    try {
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
        // A REJECTION RELEASES THE CLAIM, like every other one. This arm returns
        // rather than throwing, so it slipped past the catch below and burned a
        // single-use invite for a request that created no member and no grant —
        // the opposite of the "NO state changes on rejection" this method
        // promises. The verdict is a rejection wherever it is decided.
        //
        // Defensive rather than reachable from outside: a duplicate device is
        // refused by MLS first (which throws, and the catch releases), and a
        // mismatched credential identity requires a forged KeyPackage. It is
        // released here for the same reason the check exists at all.
        if (claimed !== null) await inviteStore.releaseInviteUse(invite.invite_id);
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
        snapshotId: globalThis.crypto.randomUUID(),
      });
      if (snapshotBase) {
        this.session = { ...this.session, snapshotBase };
        await putRoomSession(this.session);
      }
      // …NOW re-announce (AFTER the commit + the grant snapshot).  This must follow `commitSnapshot`,
      // not precede it: `commitSnapshot` compacts A's log — dropping the just-authored `member.add` — so
      // announcing BEFORE it would advertise a head the peer can no longer pull (A would serve 0), and
      // the peer would strand on the missing prefix.  Announcing AFTER advertises the SNAPSHOT head +
      // `latest_snapshot_id`, so a connected member that already advanced the epoch (via the commit
      // above) bootstraps the new member/device/content over the §14.5 snapshot archive
      // (PRIV-WEB-SESSION-NUDGE).
      this.nudgeActiveSessions();
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
      // Already charged by the claim above; only a driver that owns the
      // accounting still charges here.
      if (driverOwnsBudget) await inviteStore.incrementInviteUses(invite.invite_id);
      return { verdict, grant };
    } catch (error) {
      if (claimed !== null) await inviteStore.releaseInviteUse(invite.invite_id);
      throw error;
    }
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
      /** The §21 capability, from the HPKE-SEALED invite this joiner opened —
       *  never from the plaintext grant. */
      readonly directory?: StoredDirectoryStub['capability'];
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
    const genesisFounderDeviceId = await verifiedFounderDeviceId(
      p2p,
      grant.manifest,
      grant.manifestCommitment,
    );
    // FAIL CLOSED: the join folds from EMPTY and then imports the grant archive, so a
    // grant whose manifest fails founder-commitment verification (a malicious inviter
    // pointing `founder` at itself) must be REJECTED — otherwise a bootstrap co-member
    // could seat a forged lower-Lamport genesis. There is no base exception here.
    if (genesisFounderDeviceId === undefined) {
      throw new Error(
        `private-p2p: room ${grant.roomId} grant manifest failed founder-commitment verification — refusing to join (WS-S §12.1)`,
      );
    }
    const engine = await p2p.PrivateRoomEngine.load({
      roomId: grant.roomId,
      roomIdCommitment: grant.roomIdCommitment,
      storage:
        joiner.createStorage?.(grant.roomId) ?? new IndexedDbPrivateRoomStorage(grant.roomId),
      epochs: new Map([[epochNum, p2p.heldKeysOf(epochState)]]),
      bootstrapDevices: grant.bootstrapDevices,
      ...(genesisFounderDeviceId ? { genesisFounderDeviceId } : {}),
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
      ...(joiner.directory ? { directoryStub: { capability: joiner.directory } } : {}),
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
  removeMember(params: {
    readonly memberId: string;
    readonly deviceId: string;
    readonly reason?: string;
  }): Promise<void> {
    return this.runExclusive(() => this.removeMemberImpl(params));
  }

  private async removeMemberImpl(params: {
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
    // Tear down the EVICTED device's live session BEFORE any post-removal broadcast, so its still-open
    // channel can no longer request or be served post-removal ops (ciphertext + metadata) — the
    // broadcast + re-announce below then reach only the REMAINING members (PRIV-WEB-SESSION-EVICT).
    this.closeSessionsForDevice(params.deviceId);
    this.broadcastCommit(this.p2p.encodeCommit(removed.commit), epoch);
    // …then re-announce so remaining members PULL the `device.remove` op (PRIV-WEB-SESSION-NUDGE).
    this.nudgeActiveSessions();
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
