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
  HeadAnnouncement,
  IngestReport,
  MlsCommitMessage,
  OpRequest,
  OpResponse,
  PrivateEncryptedEnvelope,
  SyncMessage,
} from '@licio/private-p2p';

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

/** The slice of `PrivateRoomEngine` the session drives (so it is mockable). */
export interface SyncEngineSurface {
  headAnnouncement(latestSnapshotId?: string): HeadAnnouncement;
  wantedFrom(announcement: HeadAnnouncement): string[];
  serveOps(opIds: readonly string[]): Promise<PrivateEncryptedEnvelope[]>;
  ingest(envelopes: readonly PrivateEncryptedEnvelope[]): Promise<IngestReport>;
  missingDependencies(): string[];
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
}

/** The §15.7 op-id request cap (mirrors `MAX_OP_IDS_PER_REQUEST` in the package). */
const DEFAULT_MAX_OP_IDS_PER_REQUEST = 4_096;

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
      this.closed = true;
    });
    this.announce();
  }

  /** Tear down (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
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

  private requestOps(opIds: readonly string[]): void {
    // Drop op ids we have already requested this session (the livelock guard): each is
    // asked for at most once, so a served-but-unopenable op never ping-pongs.
    const fresh = [...new Set(opIds)].filter((id) => !this.requested.has(id)).sort();
    if (fresh.length === 0) return;
    for (const id of fresh) this.requested.add(id);
    for (let i = 0; i < fresh.length; i += this.maxOpIds) {
      this.sendMessage({
        schema: 'licio.private.op_request.v1',
        op_ids: fresh.slice(i, i + this.maxOpIds),
      });
    }
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
    this.announce();
    const next = [
      ...this.engine.missingDependencies(),
      ...(this.peerAnnouncement ? this.engine.wantedFrom(this.peerAnnouncement) : []),
    ];
    this.requestOps(next);
  }

  private async onAnnouncement(announcement: HeadAnnouncement): Promise<void> {
    this.peerAnnouncement = announcement;
    this.requestOps(this.engine.wantedFrom(announcement));
  }

  private async onRequest(request: OpRequest): Promise<void> {
    const envelopes = await this.engine.serveOps(request.op_ids);
    this.sendMessage({ schema: 'licio.private.op_response.v1', envelopes });
  }

  private async onResponse(response: OpResponse): Promise<void> {
    if (response.envelopes.length === 0) return;
    const report = await this.engine.ingest(response.envelopes);
    this.options.onProgress?.(report.accepted);
    // Walk the causal DAG: any retained op's still-missing parents + any heads of the
    // peer's last announcement we still lack.
    const next = [
      ...this.engine.missingDependencies(),
      ...(this.peerAnnouncement ? this.engine.wantedFrom(this.peerAnnouncement) : []),
    ];
    this.requestOps(next);
    // Re-announce ONLY on genuine progress, so the peer can pull our new heads and the
    // protocol still terminates (no progress ⇒ no re-announce ⇒ quiescence).
    if (report.accepted.length > 0) this.announce();
  }
}
