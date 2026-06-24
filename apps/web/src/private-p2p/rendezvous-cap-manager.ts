// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the carrier-side rendezvous-cap orchestration (docs/private-p2p/
// TIER2-RENDEZVOUS-CAP.md §11). Loads the `@licio/private-p2p/rendezvous-cap` subpath LAZILY
// (dynamic import only — `check:private-p2p-split`), holds the device's `RendezvousMember`
// (its `nid` persisted) + the admin's issuer SEED (persisted, deterministic per epoch), drives
// the request → issue → install protocol over the room engine, and builds the connect-peer
// cap hooks. All cap material is device-local; the issuer never learns `nid` (blind issuance).

import type { RendezvousCapHooks } from './connect-peer.js';

type CapModule = typeof import('@licio/private-p2p/rendezvous-cap');
type Member = InstanceType<CapModule['RendezvousMember']>;

/** Device-local persistence (the room store provides this; the `nid`/seed never leave). */
export interface RendezvousCapStorage {
  loadNid(): Promise<Uint8Array | undefined>;
  saveNid(nid: Uint8Array): Promise<void>;
  loadIssuerSeed(): Promise<Uint8Array | undefined>;
  saveIssuerSeed(seed: Uint8Array): Promise<void>;
}

/** The engine reads the manager drives over (a subset of `PrivateRoomEngine`). */
export interface CapEngine {
  rendezvousCommitments(): { deviceId: string; commitmentWithProof: string }[];
  rendezvousIssuances(): {
    target_epoch: number;
    issuer_public_key: string;
    credentials: ReadonlyArray<{ device_id: string; signature: string }>;
  }[];
}

export interface CapIssuanceOpBody {
  readonly target_epoch: number;
  readonly issuer_public_key: string;
  readonly credentials: ReadonlyArray<{ device_id: string; signature: string }>;
}

export interface CapSyncContext {
  readonly engine: CapEngine;
  readonly deviceId: string;
  readonly epoch: number;
  readonly isAdmin: boolean;
  /** Author a `rendezvous.request` carrying this device's base64url commitment. */
  authorRequest(commitmentWithProof: string): Promise<void>;
  /** Author a `rendezvous.issue` op (admin only). */
  authorIssue(body: CapIssuanceOpBody): Promise<void>;
}

/**
 * Per-room, per-device cap orchestration. One instance per open private room; call `sync`
 * after each engine ingest (the request/issue/install converges over a few rounds) and
 * `hooks(epoch)` to obtain the connect-peer cap hooks (or `undefined` ⇒ ride Tier-1).
 */
export class RendezvousCapManager {
  private cap: CapModule | undefined;
  private member: Member | undefined;

  constructor(private readonly storage: RendezvousCapStorage) {}

  private async load(): Promise<{ cap: CapModule; member: Member }> {
    if (this.cap === undefined) this.cap = await import('@licio/private-p2p/rendezvous-cap');
    if (this.member === undefined) {
      let nid = await this.storage.loadNid();
      if (nid === undefined) {
        nid = this.cap.generateNidSecret();
        await this.storage.saveNid(nid);
      }
      this.member = new this.cap.RendezvousMember(nid);
    }
    return { cap: this.cap, member: this.member };
  }

  /**
   * Drive the cap protocol for `ctx.epoch`: publish our commitment (once), install our
   * credential from accepted issuances, and — if admin — issue for any committed device not
   * yet credentialed under our (deterministic) issuer key. Idempotent + convergent.
   */
  async sync(ctx: CapSyncContext): Promise<void> {
    const { cap, member } = await this.load();
    const commitments = ctx.engine.rendezvousCommitments();

    // 1. Publish our blind commitment once (when the converged state lacks it).
    if (!commitments.some((c) => c.deviceId === ctx.deviceId)) {
      await ctx.authorRequest(cap.toBase64Url(member.commitment));
    }

    // 2. Install our per-epoch credential from the accepted issuances.
    cap.installFromIssuances(member, ctx.deviceId, ctx.epoch, ctx.engine.rendezvousIssuances());

    // 3. As admin: issue for every committed device not yet credentialed under OUR key.
    if (ctx.isAdmin && commitments.length > 0) {
      let seed = await this.storage.loadIssuerSeed();
      if (seed === undefined) {
        seed = cap.generateIssuerSeed();
        await this.storage.saveIssuerSeed(seed);
      }
      const issuer = cap.RendezvousIssuer.fromSeed(seed, String(ctx.epoch));
      const ourKey = cap.toBase64Url(issuer.publicKey);
      const alreadyIssued = new Set<string>(
        ctx.engine
          .rendezvousIssuances()
          .filter((i) => i.target_epoch === ctx.epoch && i.issuer_public_key === ourKey)
          .flatMap((i) => i.credentials.map((c) => c.device_id)),
      );
      const body = cap.buildIssuanceOpBody(issuer, ctx.epoch, commitments, alreadyIssued);
      if (body !== null) {
        await ctx.authorIssue({
          target_epoch: body.target_epoch,
          issuer_public_key: body.issuer_public_key,
          credentials: body.credentials,
        });
      }
    }
  }

  /**
   * The connect-peer cap hooks for `epoch`, or `undefined` if this device is not yet enrolled
   * (⇒ the carrier rides Tier-1 — fail-open). When enrolled, `build` produces the device's cap
   * and `filterVerified` runs the §6.8 serverless cap (`filterVerifiedPresence`) over the
   * polled candidates under the room issuer key.
   */
  async hooks(epoch: number): Promise<RendezvousCapHooks | undefined> {
    const { cap, member } = await this.load();
    const issuerKeyBytes = member.issuerKey(String(epoch));
    if (issuerKeyBytes === null) return undefined;
    const issuerKey = cap.issuerKeyFromBytes(issuerKeyBytes); // parse once, reuse per poll
    return {
      build: (roomBlindId, e, bucket) => {
        const built = cap.buildAnnouncementCap(member, roomBlindId, e, bucket);
        if (built === null) return null;
        // The per-epoch issuer public key the TOP-LEVEL cap carries so a key-less verifier
        // (server/relay) can check the proof. Computed for build's OWN epoch `e`.
        const keyForEpoch = member.issuerKey(String(e));
        if (keyForEpoch === null) return null;
        return {
          proof: built.proof,
          pseudonym: built.pseudonym,
          issuerPubKey: cap.toBase64Url(keyForEpoch),
        };
      },
      filterVerified: (caps, roomBlindId, e, bucket, nowMs) =>
        cap
          .filterVerifiedPresence(
            caps.map((c, i) => ({
              pseudonym: cap.fromBase64Url(c.pseudonym),
              proof: cap.fromBase64Url(c.proof),
              epoch: String(e),
              bucket,
              value: i,
            })),
            issuerKey,
            new TextEncoder().encode(roomBlindId),
            { nowMs },
          )
          .map((v) => v.value),
    };
  }
}
