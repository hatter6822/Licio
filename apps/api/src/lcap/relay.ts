// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The optional untrusted relay (OFFLINE_SPEC §22.4, §33.4, WS-R.15.3).  An
// operator-run relay MAY store records/proofs/blocks by CID, serve them to LAN
// peers, enforce the §27.3 quotas (WS-R.14.4), and refuse private content unless it
// is encrypted + permitted — but it MUST NOT mark content globally accepted, rewrite
// records, bypass proof validation, or store unencrypted private content.  The
// "cannot accept" property is STRUCTURAL: this class exposes only `admit`/`serve`
// (a content-addressed cache) and holds NO room acceptance log / commit path — the
// canonical accept decision lives only in `LcapIngestServer` (§24.1).  Abuse control
// reads no client network address (§19.1); usage is keyed by an opaque peer ref.

import {
  admitRelayObject,
  cidFor,
  DEFAULT_RELAY_QUOTA,
  type LcapLane,
  type RelayQuotaConfig,
  type RelayUsage,
} from '@licio/lcap';
import type { LcapContentKind, StoredObject } from './store.js';

/** The content-addressed cache a relay binds (the CAS subset of `LcapServerStore`). */
export interface RelayObjectStore {
  hasObject(cid: string): Promise<boolean>;
  getObject(cid: string): Promise<StoredObject | undefined>;
  storeObject(cid: string, kind: LcapContentKind, bytes: Uint8Array): Promise<void>;
}

/** An object a peer offers the relay to store (its disclosure-relevant metadata). */
export interface RelayObjectInput {
  readonly cid: string;
  readonly kind: LcapContentKind;
  readonly bytes: Uint8Array;
  readonly lane: LcapLane;
  /** An OPAQUE peer reference (never a network address; §19.1). */
  readonly peerId: string;
  readonly roomId: string;
  /** Whether a cheap signature/schema check passed (drives the invalid-ratio throttle). */
  readonly verified: boolean;
  readonly visibility: 'public' | 'in_room' | 'private';
  /** Whether the payload is ciphertext (required for any private-room relay). */
  readonly encrypted: boolean;
  /** Whether room policy permits relaying this (required for private). */
  readonly permitted: boolean;
}

export type RelayRefusal =
  | 'rejected_bad_cid'
  | 'private_content_refused'
  | 'object_too_large'
  | 'peer_quota'
  | 'room_quota'
  | 'unverified_quota'
  | 'invalid_ratio'
  | 'capacity';

/** A storage receipt — a relay returns a receipt, NEVER an `accepted`/canonical verdict. */
export type RelayReceipt =
  | { readonly stored: true; readonly cid: string; readonly alreadyHad: boolean }
  | { readonly stored: false; readonly cid: string; readonly refused: RelayRefusal };

interface MutableUsage {
  peerBytes: number;
  peerObjectsSeen: number;
  peerObjectsInvalid: number;
}

/**
 * An untrusted, content-addressed relay cache.  `admit` CID-verifies, refuses
 * unencrypted/unpermitted private content, applies the §27.3 quota policy, then
 * stores idempotently and returns a receipt; `serve` returns held bytes by CID.
 * There is deliberately NO accept/commit/room-log surface.
 */
export class LcapRelay {
  // Per-peer + per-room + per-lane usage.  In-memory BY DESIGN: the relay is an ephemeral,
  // untrusted content-addressed cache (§15.3) with no accept/commit surface, so its admission
  // quotas are simply a fresh budget per process — there is no durable state to keep.  Opaque
  // peer/room keys only — never a network address (§19.1).
  private readonly peer = new Map<string, MutableUsage>();
  private readonly roomBytes = new Map<string, number>();
  private readonly laneBytes: Partial<Record<LcapLane, number>> = {};
  private unverifiedBytes = 0;

  constructor(
    private readonly store: RelayObjectStore,
    private readonly quota: RelayQuotaConfig = DEFAULT_RELAY_QUOTA,
  ) {}

  private peerUsage(peerId: string): MutableUsage {
    let u = this.peer.get(peerId);
    if (!u) {
      u = { peerBytes: 0, peerObjectsSeen: 0, peerObjectsInvalid: 0 };
      this.peer.set(peerId, u);
    }
    return u;
  }

  private snapshot(peerId: string, roomId: string): RelayUsage {
    const p = this.peerUsage(peerId);
    return {
      laneUsedBytes: this.laneBytes,
      peerBytes: p.peerBytes,
      roomBytes: this.roomBytes.get(roomId) ?? 0,
      unverifiedBytes: this.unverifiedBytes,
      peerObjectsSeen: p.peerObjectsSeen,
      peerObjectsInvalid: p.peerObjectsInvalid,
    };
  }

  private noteObserved(peerId: string, invalid: boolean): void {
    const p = this.peerUsage(peerId);
    p.peerObjectsSeen += 1;
    if (invalid) p.peerObjectsInvalid += 1;
  }

  /**
   * Offer an object to the relay.  CID integrity → private-content refusal → the
   * §27.3 quota policy → idempotent store.  Returns a receipt; NEVER accepts.
   */
  async admit(input: RelayObjectInput): Promise<RelayReceipt> {
    // 1) CID integrity — a relay verifies CIDs (it never trusts the claim).
    const computed = await cidFor(input.kind, input.bytes);
    if (computed !== input.cid) {
      this.noteObserved(input.peerId, true);
      return { stored: false, cid: input.cid, refused: 'rejected_bad_cid' };
    }

    // 2) Private-content refusal: a relay MUST NOT store private content unless it is
    // encrypted AND room-policy-permitted (§22.4).
    if (input.visibility === 'private' && !(input.encrypted && input.permitted)) {
      this.noteObserved(input.peerId, true);
      return { stored: false, cid: input.cid, refused: 'private_content_refused' };
    }

    // 3) The §27.3 quota policy (WS-R.14.4).
    const decision = admitRelayObject(this.quota, this.snapshot(input.peerId, input.roomId), {
      lane: input.lane,
      sizeBytes: input.bytes.length,
      verified: input.verified,
    });
    if (!decision.admit) {
      this.noteObserved(input.peerId, !input.verified);
      return { stored: false, cid: input.cid, refused: decision.reason };
    }

    // 4) Store idempotently + update usage.  No acceptance log is touched — a relay
    // never marks canonical state (the structural "cannot accept" property).
    const alreadyHad = await this.store.hasObject(input.cid);
    await this.store.storeObject(input.cid, input.kind, input.bytes);
    this.noteObserved(input.peerId, !input.verified);
    if (!alreadyHad) {
      const p = this.peerUsage(input.peerId);
      p.peerBytes += input.bytes.length;
      this.roomBytes.set(
        input.roomId,
        (this.roomBytes.get(input.roomId) ?? 0) + input.bytes.length,
      );
      this.laneBytes[input.lane] = (this.laneBytes[input.lane] ?? 0) + input.bytes.length;
      if (!input.verified) this.unverifiedBytes += input.bytes.length;
    }
    return { stored: true, cid: input.cid, alreadyHad };
  }

  /** Serve a held object by CID to a LAN peer (no acceptance implied). */
  serve(cid: string): Promise<StoredObject | undefined> {
    return this.store.getObject(cid);
  }
}
