// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 (orchestration half) — the event-driven private-room sync session that
// runs the §15.6/§15.7 reconciliation over an ALREADY-ESTABLISHED, post-handshake
// duplex `PeerChannel` (a live WebRTC data channel, an offline archive relay, or a
// test loopback).  It is the I/O-agnostic engine driver: the RTCPeerConnection +
// blind rendezvous + membership handshake that PRODUCE the channel are the carrier
// (`connectPrivatePeer`); the byte-identical convergence MATH is the package's pure
// op-exchange protocol (proven in `@licio/private-p2p`).
//
// Type-only imports of `@licio/private-p2p` (the codec + engine are INJECTED, loaded
// from the lazy chunk by the room manager) so this module carries no static value
// import — `check:private-p2p-split` stays green.
//
// Doctrine: the channel is post-handshake (membership-proven, §15.5) and the
// counterpart's bytes are STILL untrusted — every served envelope goes through the
// engine's own `ingest` (§14.2 `openOp` + structural pre-pass); the wire confers no
// trust (§8.3).  We re-announce ONLY after genuine progress (a newly-accepted op), so
// the protocol terminates once both peers hold the union of their DAGs.

import type {
  BlockRequest,
  BlockResponse,
  HeadAnnouncement,
  IngestReport,
  MlsCommitMessage,
  OpRequest,
  OpResponse,
  PrivateEncryptedEnvelope,
  SnapshotResponse,
  SyncMessage,
} from '@licio/private-p2p';
import { devWarn } from '../lib/dev-log.js';

/** The §15.7 byte budget a block request advertises (a media chunk is ≤ 16 KiB; this caps
 *  a single request's served payload, bounded by the §27 DoS limits on both ends). */
const MAX_BLOCK_REQUEST_BYTES = 4 * 1024 * 1024;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(b64url: string): Uint8Array {
  const std = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std.length % 4 === 0 ? std : std + '='.repeat(4 - (std.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A bidirectional, framed message channel between two members (post-handshake). */
export interface PeerChannel {
  send(frame: Uint8Array): void | Promise<void>;
  onMessage(listener: (frame: Uint8Array) => void): void;
  onClose?(listener: () => void): void;
  close(): void;
}

/** The op-exchange wire codec (injected from the lazy `@licio/private-p2p` chunk). */
export interface SyncCodec {
  encodeSyncMessage(message: SyncMessage): Uint8Array;
  decodeSyncMessage(bytes: Uint8Array): SyncMessage;
}

/** The slice of `PrivateRoomEngine` the session drives (so it is mockable).  The §13.6
 *  block methods are OPTIONAL — a surface without media (a relay, a mock) simply skips
 *  the block exchange. */
export interface SyncEngineSurface {
  headAnnouncement(latestSnapshotId?: string): HeadAnnouncement;
  wantedFrom(announcement: HeadAnnouncement): string[];
  serveOps(opIds: readonly string[]): Promise<PrivateEncryptedEnvelope[]>;
  ingest(envelopes: readonly PrivateEncryptedEnvelope[]): Promise<IngestReport>;
  missingDependencies(): string[];
  /** §15.8 — the CIDs this engine still needs for its attachments (two-phase). */
  wantedBlockCids?(): Promise<string[]>;
  /** §15.7 — serve requested blocks up to a byte budget. */
  serveBlocks?(
    cids: readonly string[],
    maxBytes: number,
  ): Promise<{ served: { cid: string; bytes: Uint8Array }[]; refused: string[] }>;
  /** §15.7 — ingest fetched blocks (re-verifying each CID before storing). */
  ingestBlocks?(
    blocks: readonly { cid: string; bytes: Uint8Array }[],
  ): Promise<{ accepted: string[]; rejected: string[] }>;
  /** §15.6 — serve this room's retained §14.5 snapshot archive (or undefined). */
  snapshotArchive?(): Promise<Uint8Array | undefined>;
  /** §15.6 — adopt a peer's snapshot archive (re-validated; bootstraps a fresh/lagging
   *  engine that cannot fetch the pruned prefix op-by-op). */
  importArchive?(bytes: Uint8Array): Promise<IngestReport>;
  /** The latest §14.5 snapshot id this engine holds (to detect a peer is ahead). */
  latestSnapshotId?(): string | undefined;
  /** How many envelopes are held PENDING (awaiting an epoch key / a device cert that lives in a
   *  pruned prefix).  A non-zero count with no missing dependency is the "stuck on a compacted peer,
   *  needs the §14.5 snapshot" signal (PRIV-SESSION-SNAPSHOT-STUCK).  Absent on a mock ⇒ treated as 0. */
  pendingCount?(): number;
}

export interface PrivateSyncSessionOptions {
  /** Chunk a large want set into requests no larger than this (≤ the §15.7 cap, 4096). */
  readonly maxOpIdsPerRequest?: number;
  /** Observe sync progress (accepted op ids) and errors for the UI. */
  readonly onProgress?: (acceptedOpIds: readonly string[]) => void;
  readonly onError?: (error: unknown) => void;
  /**
   * §10.9 — apply a received MLS Commit so this engine advances to the new epoch (the
   * room manager runs `applyCommit` → `deriveEpochState` → `addEpochKeys` →
   * `retryPending`, persisting the advanced group + new keys).  After it resolves the
   * session re-announces (the newly-decryptable ops advanced our heads) and re-opens its
   * request guard.  Absent (e.g. a relay with no group), an incoming commit is ignored.
   */
  readonly onMlsCommit?: (commit: Uint8Array, epoch: number) => Promise<void>;
  /**
   * §15.4 — called when the underlying channel drops (NOT a local `close()`).
   * `graceful` is true when the peer sent a `bye` first (a deliberate leave) — a
   * reconnect manager should reconnect on a non-graceful drop but NOT on a graceful one.
   */
  readonly onClose?: (graceful: boolean) => void;
  /**
   * Fires EXACTLY ONCE when the session terminates by ANY path — a local `close()` OR an external
   * channel drop (unlike `onClose`, which a local `close()` deliberately suppresses).  The owner
   * uses it to prune the session from its live set so the set cannot leak (PRIV-WEB-SESSION-1).
   */
  readonly onTerminate?: () => void;
}

/** The §15.7 op-id request cap (mirrors `MAX_OP_IDS_PER_REQUEST` in the package). */
const DEFAULT_MAX_OP_IDS_PER_REQUEST = 4_096;

/** Cap on the per-session request-tracking sets (`requested` / `requestedBlocks`) — a §27 memory
 *  bound mirroring the engine's own MAX_PENDING_ENVELOPES.  A malicious member can stream
 *  `head_announcement` floods of 4096 fresh random op ids per frame; without a cap each frame would
 *  permanently grow `requested` (the ids are never served, so they never clear) → renderer OOM.  An
 *  evicted-but-still-wanted id is simply re-requested by a later reconciliation walk, so the cap
 *  loses no content (PRIV-SESSION-REQ-BOUND). */
const MAX_TRACKED_IDS = 8_192;

/** Add `id` to a request-tracking set, evicting the oldest entry (insertion order) once at the cap. */
function boundedAdd(set: Set<string>, id: string): void {
  if (!set.has(id) && set.size >= MAX_TRACKED_IDS) {
    const oldest = set.keys().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(id);
}

/** The §13.6 block-request CID cap (mirrors `MAX_CIDS_PER_BLOCK_REQUEST` in the package — a value
 *  import would breach the `check:private-p2p-split` dynamic-only boundary).  A `block_request`
 *  rejects > this many CIDs at the zod boundary, so the media-want loop chunks by THIS, not the
 *  larger op-id cap — otherwise an attachment with > 1024 missing chunks throws before sending. */
const MAX_CIDS_PER_BLOCK_REQUEST = 1_024;

/** The largest §14.5 snapshot archive (raw bytes) the LIVE carrier serves in one `snapshot_response`
 *  (mirrors `MAX_LIVE_SNAPSHOT_ARCHIVE_BYTES` in the package — a value import would breach the
 *  `check:private-p2p-split` dynamic-only boundary).  A larger snapshot is declined here (the peer
 *  bootstraps via the §15.9 offline CAR archive instead) rather than emitting an unsendable frame. */
const MAX_LIVE_SNAPSHOT_ARCHIVE_BYTES = 11 * 1024 * 1024;

export class PrivateSyncSession {
  private peerAnnouncement: HeadAnnouncement | null = null;
  private closed = false;
  /** Serialize message handling so ingest/serve never interleave (the engine is not
   *  re-entrant; out-of-order folds would corrupt the fixpoint). */
  private queue: Promise<void> = Promise.resolve();
  private readonly maxOpIds: number;
  /** Op ids already requested this session (the §15.7 livelock guard): a served-but-
   *  unopenable op (e.g. sealed under an epoch we lack — now retained in the engine's
   *  pending pool) is NOT re-requested.  Cleared when an MLS commit advances our epoch,
   *  so anything still genuinely wanted is re-requested once. */
  private readonly requested = new Set<string>();
  /** Block CIDs already requested this session (the §15.8 block-fetch livelock guard):
   *  a refused/not-held block is not re-requested.  Cleared when an MLS commit advances
   *  the epoch (a newly-openable manifest may reveal chunk CIDs). */
  private readonly requestedBlocks = new Set<string>();
  /** Whether we have already asked this peer for its §14.5 snapshot archive (request it
   *  at most once per stall, so a peer with nothing to serve does not cause a loop). */
  private snapshotRequested = false;
  /** Whether the peer sent a `bye` (a deliberate leave) — so a channel drop is reported
   *  as graceful (do not reconnect). */
  private peerSaidBye = false;
  /** Whether close() was called locally — so the resulting channel onClose does not
   *  fire `options.onClose` (the caller already knows it is tearing down). */
  private selfClosed = false;
  /** Guards `onTerminate` to fire AT MOST ONCE across the close() + channel-drop paths. */
  private terminated = false;

  /** Whether the session has ended (by either path) — lets an owner lazily prune a closed session. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Fire the terminal teardown hook exactly once (PRIV-WEB-SESSION-1). */
  private fireTerminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.options.onTerminate?.();
  }

  constructor(
    private readonly engine: SyncEngineSurface,
    private readonly channel: PeerChannel,
    private readonly codec: SyncCodec,
    private readonly options: PrivateSyncSessionOptions = {},
  ) {
    this.maxOpIds = options.maxOpIdsPerRequest ?? DEFAULT_MAX_OP_IDS_PER_REQUEST;
  }

  /** Begin syncing: wire the channel and send our opening head announcement. */
  start(): void {
    this.channel.onMessage((frame) => this.enqueue(() => this.handleFrame(frame)));
    this.channel.onClose?.(() => {
      const wasOpen = !this.closed;
      this.closed = true;
      // Report an EXTERNAL drop to the reconnect manager (a local close() set selfClosed,
      // and the caller already knows it is tearing down).  graceful ⇔ the peer said bye.
      if (wasOpen && !this.selfClosed) this.options.onClose?.(this.peerSaidBye);
      this.fireTerminate(); // prune from the owner's live set on EITHER path (once)
    });
    this.announce();
  }

  /**
   * Tear down (idempotent).  `graceful` (default) sends a §15.4 `bye` first so the peer
   * does not treat the close as a network drop + reconnect; pass `false` to drop silently.
   */
  close(graceful = true): void {
    if (this.closed) return;
    this.selfClosed = true;
    this.closed = true;
    if (graceful) {
      // AWAIT the bye's seal+send before closing the channel (PRIV-SESSION-BYE).  Over the real
      // carrier `channel.send` is async (it `await`s the AEAD seal before `dc.send`), so a synchronous
      // `channel.close()` here would run BEFORE the seal resolves — `dc.send` would then throw on the
      // already-closing channel and the §15.4 `bye` would never reach the peer, making EVERY deliberate
      // leave look like a network drop (the peer re-dials the leaver, churning maintainMesh's
      // gracefulCooldown).  Awaiting enqueues the bye into the SCTP buffer, which the WebRTC close()
      // procedure then flushes.  (`sendMessage` is not usable here — it no-ops once `closed` is set.)
      void Promise.resolve(
        this.channel.send(this.codec.encodeSyncMessage({ schema: 'licio.private.bye.v1' })),
      )
        .catch(() => {
          /* the peer will observe the drop regardless — best-effort graceful leave */
        })
        .finally(() => this.channel.close());
    } else {
      this.channel.close();
    }
    this.fireTerminate(); // a local close() also prunes the owner's live set (onClose is suppressed)
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error) => this.options.onError?.(error));
  }

  private sendMessage(message: SyncMessage): void {
    if (this.closed) return;
    void Promise.resolve(this.channel.send(this.codec.encodeSyncMessage(message))).catch((error) =>
      this.options.onError?.(error),
    );
  }

  private announce(): void {
    this.sendMessage(this.engine.headAnnouncement());
  }

  /**
   * §15.6 — re-announce our heads to the peer after LOCAL progress (the owner authored an op /
   * admitted or removed a member).  Without this, a live session goes quiescent after its initial
   * convergence and a subsequently-authored op NEVER reaches the connected peer (the peer only
   * pulls when we announce, and we otherwise announce only on RECEIVED progress).  Idempotent + a
   * no-op once closed (via `sendMessage`); the peer pulls the new heads, converges, and quiesces
   * again — each local author is finite progress, so this cannot livelock.
   */
  reannounce(): void {
    this.announce();
  }

  /** Request the FRESH op ids (never re-requesting one already asked for this session — the §15.7
   *  livelock guard).  Returns how many fresh ids were requested (0 ⇒ we asked for nothing new,
   *  the "stuck?" signal onResponse uses to fall back to the §14.5 snapshot). */
  private requestOps(opIds: readonly string[]): number {
    const fresh = [...new Set(opIds)].filter((id) => !this.requested.has(id)).sort();
    if (fresh.length === 0) return 0;
    for (const id of fresh) boundedAdd(this.requested, id); // §27-bounded (PRIV-SESSION-REQ-BOUND)
    for (let i = 0; i < fresh.length; i += this.maxOpIds) {
      this.sendMessage({
        schema: 'licio.private.op_request.v1',
        op_ids: fresh.slice(i, i + this.maxOpIds),
      });
    }
    return fresh.length;
  }

  /**
   * §10.9 — broadcast an MLS Commit to this peer so it advances to the new epoch after a
   * local add/remove.  The room manager calls this on every active session after it
   * authors the membership change.  `commit` is `encodeCommit(...)` bytes; `epoch` is the
   * new MLS epoch.
   */
  sendMlsCommit(commit: Uint8Array, epoch: number): void {
    this.sendMessage({
      schema: 'licio.private.mls_commit.v1',
      commit: bytesToBase64Url(commit),
      epoch,
    });
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    if (this.closed) return;
    const message = this.codec.decodeSyncMessage(frame); // throws on garbage → onError
    switch (message.schema) {
      case 'licio.private.head_announcement.v1':
        await this.onAnnouncement(message);
        return;
      case 'licio.private.op_request.v1':
        await this.onRequest(message);
        return;
      case 'licio.private.op_response.v1':
        await this.onResponse(message);
        return;
      case 'licio.private.mls_commit.v1':
        await this.onMlsCommitMessage(message);
        return;
      case 'licio.private.block_request.v1':
        await this.onBlockRequest(message);
        return;
      case 'licio.private.block_response.v1':
        await this.onBlockResponse(message);
        return;
      case 'licio.private.snapshot_request.v1':
        await this.onSnapshotRequest();
        return;
      case 'licio.private.snapshot_response.v1':
        await this.onSnapshotResponse(message);
        return;
      case 'licio.private.bye.v1':
        // The peer is leaving deliberately — mark it so the imminent channel drop is
        // reported as graceful (the reconnect manager must NOT reconnect to a leaver).
        this.peerSaidBye = true;
        return;
    }
  }

  private async onMlsCommitMessage(message: MlsCommitMessage): Promise<void> {
    if (!this.options.onMlsCommit) return; // no group to advance (e.g. a relay) — ignore
    await this.options.onMlsCommit(base64UrlToBytes(message.commit), message.epoch);
    // The new epoch key re-opened the engine's pending ops, advancing our heads AND
    // revealing the parents of a previously-unopenable frontier head.  Re-open the
    // request guard (a key arrived), re-announce so the peer pulls our new heads, and
    // DRIVE the walk for the newly-revealed ancestors (a frontier at the new epoch could
    // not be traversed until now).
    this.requested.clear();
    this.requestedBlocks.clear(); // a new epoch may open a manifest revealing chunk CIDs
    this.snapshotRequested = false; // a new epoch is genuinely new state — a snapshot may now be needed
    this.announce();
    const next = [
      ...this.engine.missingDependencies(),
      ...(this.peerAnnouncement ? this.engine.wantedFrom(this.peerAnnouncement) : []),
    ];
    this.requestOps(next);
    await this.requestBlocks();
  }

  private async onAnnouncement(announcement: HeadAnnouncement): Promise<void> {
    this.peerAnnouncement = announcement;
    this.requestOps(this.engine.wantedFrom(announcement));
    await this.requestBlocks();
  }

  private async onRequest(request: OpRequest): Promise<void> {
    const envelopes = await this.engine.serveOps(request.op_ids);
    this.sendMessage({ schema: 'licio.private.op_response.v1', envelopes });
  }

  private async onResponse(response: OpResponse): Promise<void> {
    if (response.envelopes.length === 0) {
      // The peer served nothing for what we asked — it may have PRUNED the prefix we need
      // (a compacted room).  If we are still missing deps and the peer announced a
      // snapshot we lack, request its snapshot archive to bootstrap (§15.6).
      await this.maybeRequestSnapshot();
      return;
    }
    const report = await this.engine.ingest(response.envelopes);
    this.options.onProgress?.(report.accepted);
    // Walk the causal DAG: any retained op's still-missing parents + any heads of the
    // peer's last announcement we still lack.
    const next = [
      ...this.engine.missingDependencies(),
      ...(this.peerAnnouncement ? this.engine.wantedFrom(this.peerAnnouncement) : []),
    ];
    const requestedFresh = this.requestOps(next);
    // Newly-accepted attachment.add ops may want blocks (the §15.8 lazy media fetch).
    await this.requestBlocks();
    // Re-announce ONLY on genuine progress, so the peer can pull our new heads and the
    // protocol still terminates (no progress ⇒ no re-announce ⇒ quiescence).
    if (report.accepted.length > 0) this.announce();
    // STUCK on a pruned prefix (PRIV-SESSION-SNAPSHOT-STUCK): a compacted peer serves its retained
    // post-snapshot ops (a NON-empty response, so the empty-response branch above never fires) but
    // OMITS the pruned ancestors.  If this round requested NOTHING new (every remaining want is
    // already guarded) yet we are still missing material — an unmet dependency, OR ops held pending
    // because their author certs live in the pruned prefix (missingDependencies() empty but
    // pendingCount() > 0) — bootstrap via the peer's §14.5 snapshot instead of quiescing incomplete.
    if (requestedFresh === 0 && this.isStuck()) {
      await this.maybeRequestSnapshot();
    }
  }

  /** Whether the engine cannot make progress on its own: it still lacks a dependency, or holds ops
   *  PENDING behind material (an epoch key / a device cert) that lives in a pruned prefix. */
  private isStuck(): boolean {
    return this.engine.missingDependencies().length > 0 || (this.engine.pendingCount?.() ?? 0) > 0;
  }

  /**
   * §15.8 — request the §13.6 attachment blocks this engine still needs (manifest CIDs
   * first; the chunk CIDs a manifest reveals are requested on the NEXT pass after the
   * manifest arrives).  The `requestedBlocks` guard asks for each CID at most once, so a
   * refused/not-held block never ping-pongs.  No-op if the surface has no media support.
   */
  private async requestBlocks(): Promise<void> {
    if (this.closed || !this.engine.wantedBlockCids) return;
    const cids = await this.engine.wantedBlockCids();
    const fresh = [...new Set(cids)].filter((c) => !this.requestedBlocks.has(c)).sort();
    if (fresh.length === 0) return;
    for (const c of fresh) boundedAdd(this.requestedBlocks, c); // §27-bounded (PRIV-SESSION-REQ-BOUND)
    for (let i = 0; i < fresh.length; i += MAX_CIDS_PER_BLOCK_REQUEST) {
      this.sendMessage({
        schema: 'licio.private.block_request.v1',
        cids: fresh.slice(i, i + MAX_CIDS_PER_BLOCK_REQUEST),
        priority: 'media',
        max_bytes: MAX_BLOCK_REQUEST_BYTES,
      });
    }
  }

  private async onBlockRequest(request: BlockRequest): Promise<void> {
    if (!this.engine.serveBlocks) return;
    const { served, refused } = await this.engine.serveBlocks(request.cids, request.max_bytes);
    this.sendMessage({
      schema: 'licio.private.block_response.v1',
      blocks: served.map((b) => ({ cid: b.cid, data: bytesToBase64Url(b.bytes) })),
      refused_cids: refused,
    });
  }

  private async onBlockResponse(response: BlockResponse): Promise<void> {
    if (!this.engine.ingestBlocks) return;
    // A block REFUSED for budget (the server's per-request byte cap) is still held by the
    // peer — un-guard it so it is re-requested on the next pass.  Otherwise an attachment
    // larger than one request's budget would strand its tail chunks forever (the guard
    // only clears on an MLS commit).  A genuinely not-held CID is simply re-requested once
    // and refused again — bounded, because progress on OTHER blocks is what re-drives.
    for (const cid of response.refused_cids) this.requestedBlocks.delete(cid);
    if (response.blocks.length > 0) {
      await this.engine.ingestBlocks(
        response.blocks.map((b) => ({ cid: b.cid, bytes: base64UrlToBytes(b.data) })),
      );
    }
    // Re-drive ONLY on accepted-block progress.  A budget-refused chunk is un-guarded above, so it
    // is retried by a re-drive that ACTUAL progress (an accepted block here, or a later MLS commit)
    // triggers — never by the refusal alone.  Re-driving on a refused-ONLY response would spin
    // `block_request`/`block_response` forever (an oversized/never-served CID stays wanted), so a
    // peer that only refuses cannot livelock the exchange; it simply makes no progress this round.
    if (response.blocks.length > 0) {
      await this.requestBlocks();
    }
  }

  /**
   * §15.6 — request the peer's snapshot archive if we are STUCK (still missing deps the
   * peer did not serve) AND the peer announced a §14.5 snapshot we do not hold.  At most
   * once per session (a peer with nothing to serve replies empty; we do not loop).
   */
  private async maybeRequestSnapshot(): Promise<void> {
    if (this.closed || this.snapshotRequested || !this.engine.importArchive) return;
    // STUCK: we lack material the peer did not serve (it likely pruned it) — an unmet dependency OR
    // ops held pending behind a key/cert in the pruned prefix — and the peer announced a §14.5
    // snapshot.  Request its archive to bootstrap the prefix.  (We cannot gate on
    // `latestSnapshotId === peerSnapshot`: holding the snapshot.commit OP — which the op walk fetches
    // — does NOT mean we hold the snapshot BASE/state.)
    if (!this.isStuck()) return;
    if (this.peerAnnouncement?.latest_snapshot_id === undefined) return;
    this.snapshotRequested = true;
    this.sendMessage({ schema: 'licio.private.snapshot_request.v1' });
  }

  private async onSnapshotRequest(): Promise<void> {
    if (!this.engine.snapshotArchive) return;
    const archive = await this.engine.snapshotArchive();
    if (!archive) return; // nothing retained to serve
    // A snapshot too large for ONE live sync message cannot cross the carrier (it would exceed the
    // fragmenter's reassembly cap / the decode budget), and encoding it would THROW at the schema cap
    // — a silent stall.  DECLINE gracefully instead (PRIV-SYNC-FRAGMENT): the requester stays op-by-op
    // or bootstraps via the §15.9 offline CAR archive, whose decode budget is larger.
    if (archive.length > MAX_LIVE_SNAPSHOT_ARCHIVE_BYTES) {
      devWarn(
        `snapshot archive of ${archive.length} bytes exceeds the live-carrier cap; declining (use the offline archive)`,
      );
      return;
    }
    this.sendMessage({
      schema: 'licio.private.snapshot_response.v1',
      archive: bytesToBase64Url(archive),
    });
  }

  private async onSnapshotResponse(response: SnapshotResponse): Promise<void> {
    if (!this.engine.importArchive) return;
    // Adopt the peer's snapshot (importArchive re-verifies the in-band commit + ingests).
    await this.engine.importArchive(base64UrlToBytes(response.archive));
    // The base + post-snapshot ops may have advanced our heads + revealed wants; re-open
    // the guards and re-drive the walk (the prefix is no longer needed op-by-op).
    this.requested.clear();
    this.announce();
    const next = [
      ...this.engine.missingDependencies(),
      ...(this.peerAnnouncement ? this.engine.wantedFrom(this.peerAnnouncement) : []),
    ];
    this.requestOps(next);
    await this.requestBlocks();
  }
}

/** A handle to a maintained (auto-reconnecting) connection. */
export interface ReconnectController {
  /** Stop maintaining + gracefully close the current session (no further reconnects). */
  close(): void;
  /** The current lifecycle status. */
  status(): ReconnectStatus;
}

export type ReconnectStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed';

export interface MaintainOptions {
  /** Max reconnect attempts after a non-graceful drop before giving up (default 5). */
  readonly maxAttempts?: number;
  /** Base backoff (ms); attempt N waits `backoffMs * 2^(N-1)`, capped (default 1000). */
  readonly backoffMs?: number;
  /** Cap on the backoff delay (default 30s). */
  readonly maxBackoffMs?: number;
  /** Injectable sleep (tests pump a fake clock). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Observe the connection lifecycle. */
  readonly onStatus?: (status: ReconnectStatus) => void;
}

/** A live session handle a `dial` returns. */
export interface DialedSession {
  close(graceful?: boolean): void;
}

/**
 * §15.4 — maintain a connection across network drops: dial, and on a NON-GRACEFUL channel
 * drop (the peer did not send `bye`) RE-DIAL with bounded exponential backoff.  A graceful
 * drop (the peer left), a local `close()`, or exhausting `maxAttempts` stops reconnecting.
 * A successful (re)connect resets the backoff.  `dial` is INJECTED so this is transport-
 * agnostic + unit-testable: it receives the `onClose(graceful)` to wire into the session it
 * creates (e.g. `PrivateSyncSession`'s `onClose` option) and returns a handle to close.
 */
export function maintainConnection(
  dial: (onClose: (graceful: boolean) => void) => Promise<DialedSession>,
  options: MaintainOptions = {},
): ReconnectController {
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffMs = options.backoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stopping = false;
  let current: DialedSession | null = null;
  let attempt = 0;
  let status: ReconnectStatus = 'connecting';
  const setStatus = (s: ReconnectStatus): void => {
    status = s;
    options.onStatus?.(s);
  };
  const delayFor = (n: number): number => Math.min(backoffMs * 2 ** (n - 1), maxBackoffMs);

  const onClose = (graceful: boolean): void => {
    current = null;
    if (stopping || graceful) {
      setStatus('closed');
      return;
    }
    if (attempt >= maxAttempts) {
      setStatus('failed');
      return;
    }
    attempt += 1;
    setStatus('reconnecting');
    void sleep(delayFor(attempt)).then(() => {
      if (!stopping) void run();
    });
  };

  const run = async (): Promise<void> => {
    if (stopping) return;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      current = await dial(onClose);
      attempt = 0; // a successful (re)connect resets the backoff window
      setStatus('connected');
    } catch {
      if (stopping || attempt >= maxAttempts) {
        setStatus('failed');
        return;
      }
      attempt += 1;
      await sleep(delayFor(attempt));
      if (!stopping) await run();
    }
  };

  void run();
  return {
    close(): void {
      stopping = true;
      current?.close(true);
      current = null;
      setStatus('closed');
    },
    status: () => status,
  };
}

/** A handle to a maintained mesh (multiple concurrent peer sessions). */
export interface MeshController {
  /** Stop the mesh + gracefully close every peer session. */
  close(): void;
  /** The currently-connected peer device ids. */
  peers(): string[];
}

export interface MeshOptions {
  /** Max concurrent peer sessions (bounded fan-out; default 4). */
  readonly maxPeers?: number;
  /** How often to re-poll for newly-online members to fill empty slots (default 15s). */
  readonly rePollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Observe the connected-peer set as it changes. */
  readonly onMeshChange?: (peers: readonly string[]) => void;
  /**
   * After a peer leaves GRACEFULLY (sent `bye`), do NOT re-dial it for this long (default
   * 5 min) — its rendezvous presence record lingers until its TTL, so without a cooldown the
   * mesh would rediscover the leaver, re-handshake, get another `bye`, and churn once per
   * re-poll until the record expires.  The cooldown is time-bounded (NOT permanent) so a
   * peer that comes back online + re-announces is re-meshable afterwards.
   */
  readonly gracefulCooldownMs?: number;
  /** Injectable clock for the cooldown (tests pump it; defaults to `Date.now`). */
  readonly nowMs?: () => number;
}

/**
 * Dial ONE new peer not already in `connected`, wiring `onDrop(peerId)` into the session
 * it creates (so the mesh removes it on a drop).  Returns the connected peer + its session,
 * or `null` when no new peer is currently available.  Injected so the mesh is testable
 * without WebRTC.
 */
export type MeshDial = (
  connected: ReadonlySet<string>,
  onDrop: (peerId: string, graceful: boolean) => void,
) => Promise<{ peerId: string; session: DialedSession } | null>;

/**
 * §15.6-15.8 — maintain a bounded mesh of peer sessions so the local engine converges with
 * MULTIPLE online members, not just the first one dialed (a single 1:1 link only converges
 * the union the one partner already holds).  Fills up to `maxPeers` distinct peers, removes
 * a peer when its session drops, and re-polls on an interval to pick up members who come
 * online later.  `close()` gracefully leaves every peer.
 */
export function maintainMesh(dial: MeshDial, options: MeshOptions = {}): MeshController {
  const maxPeers = options.maxPeers ?? 4;
  const rePollMs = options.rePollIntervalMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cooldownMs = options.gracefulCooldownMs ?? 5 * 60_000;
  const nowMs = options.nowMs ?? (() => Date.now());
  let stopping = false;
  const sessions = new Map<string, DialedSession>();
  // peerId → timestamp until which a graceful leaver is NOT re-dialed (see gracefulCooldownMs).
  const gracefullyLeft = new Map<string, number>();
  const notify = (): void => options.onMeshChange?.([...sessions.keys()]);
  const onDrop = (peerId: string, graceful: boolean): void => {
    const removed = sessions.delete(peerId);
    // A deliberate leave: do not churn re-dialing the leaver while its rendezvous record
    // lingers.  A network drop (graceful=false) is eligible for immediate re-dial.
    if (graceful) gracefullyLeft.set(peerId, nowMs() + cooldownMs);
    if (removed) notify();
  };

  const fill = async (): Promise<void> => {
    while (!stopping && sessions.size < maxPeers) {
      // Prune expired cooldowns so a returned-online peer is re-meshable.
      const now = nowMs();
      for (const [peerId, until] of gracefullyLeft) {
        if (now >= until) gracefullyLeft.delete(peerId);
      }
      const excluded = new Set([...sessions.keys(), ...gracefullyLeft.keys()]);
      let result: { peerId: string; session: DialedSession } | null;
      try {
        result = await dial(excluded, onDrop);
      } catch (error) {
        // A dial error → wait for the next poll cycle, but surface it in dev (a persistent dial
        // failure here is a real problem, not just a peer that briefly went away).
        devWarn('peer dial failed; will retry next poll cycle', error);
        return;
      }
      if (!result) return; // no NEW peer available right now
      if (stopping) {
        result.session.close(true);
        return;
      }
      // Skip a duplicate (a slow dial that returned an already-connected peer).
      if (sessions.has(result.peerId)) {
        result.session.close(true);
        continue;
      }
      sessions.set(result.peerId, result.session);
      notify();
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopping) {
      await fill();
      if (stopping) return;
      await sleep(rePollMs);
    }
  };
  void loop();
  return {
    close(): void {
      stopping = true;
      for (const s of sessions.values()) s.close(true);
      sessions.clear();
      notify();
    },
    peers: () => [...sessions.keys()],
  };
}
