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
/** The §6.8 per-poll BBS-verify bound (PR3b anti-flood): each capped announcement costs a proof
 *  verify, so an insider flooding capped records could extract unbounded CPU.  At most this many caps
 *  are verified per poll; the §27 sample-poll re-randomizes the set each poll, so over a few polls a
 *  legitimate capped peer still surfaces, while a flood's verify cost is bounded per poll. */
const MAX_CAPS_VERIFIED_PER_POLL = 64;

/** An unbiased random integer in [0, bound) from crypto randomness — rejection sampling avoids the
 *  modulo bias a raw `% bound` over a 32-bit value would introduce. */
function randomIntBelow(bound: number): number {
  if (bound <= 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / bound) * bound; // drop the biased high tail
  const buf = new Uint32Array(1);
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0] ?? 0;
  } while (x >= limit);
  return x % bound;
}

/** A uniform random permutation of [0, n) (Fisher–Yates over crypto randomness) — the §27 per-poll
 *  re-randomization that makes MAX_CAPS_VERIFIED_PER_POLL a FAIR sample of the capped set rather than
 *  an arrival-order window.  Without it, a hostile member could keep that many decodable-but-invalid
 *  caps ahead of an honest one in the relay's STABLE poll order and starve it from verification +
 *  discovery on every poll (PRIV-CAP-4). */
function shuffledIndices(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = randomIntBelow(i + 1);
    const a = order[i] as number;
    order[i] = order[j] as number;
    order[j] = a;
  }
  return order;
}

export class RendezvousCapManager {
  // PRIV-CAP-4: memoize the WHOLE load so two concurrent first calls cannot each generate a distinct
  // `nid` (a racing read-then-write would otherwise install divergent members / persist the loser).
  private loadPromise: Promise<{ cap: CapModule; member: Member }> | undefined;

  constructor(private readonly storage: RendezvousCapStorage) {}

  private load(): Promise<{ cap: CapModule; member: Member }> {
    if (this.loadPromise === undefined) this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<{ cap: CapModule; member: Member }> {
    const cap = await import('@licio/private-p2p/rendezvous-cap');
    let nid = await this.storage.loadNid();
    if (nid === undefined) {
      nid = cap.generateNidSecret();
      await this.storage.saveNid(nid);
    }
    return { cap, member: new cap.RendezvousMember(nid) };
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
    const roomBlindIdBytes = (s: string): Uint8Array => new TextEncoder().encode(s);
    return {
      build: (roomBlindId, e, bucket) => {
        const built = cap.buildAnnouncementCap(member, roomBlindId, e, bucket);
        // The cap rides SEALED inside the announcement only (PRIV-API-RENDEZVOUS-1: no top-level cap),
        // so `build` returns just the member-verifiable {proof, pseudonym} — no issuer key (the
        // verifier is a member who already holds the issuer key via the op log).
        return built === null ? null : { proof: built.proof, pseudonym: built.pseudonym };
      },
      filterVerified: (caps, roomBlindId, e, bucket, nowMs) => {
        // PR3b anti-flood: decode each sealed cap DEFENSIVELY (a hostile member's malformed cap must
        // be SKIPPED, never crash the whole discovery batch — PRIV-CAP-2) and bound the per-poll
        // BBS-verify work (MAX_CAPS_VERIFIED_PER_POLL).  `filterVerifiedPresence` then dedups by the
        // CANONICAL parsed pseudonym (so an encoding twin cannot occupy two slots) and drops any cap
        // whose proof does not verify.  `value: i` is the ORIGINAL index so the caller maps survivors
        // back to its candidate array.
        const decoded: Array<{
          pseudonym: Uint8Array;
          proof: Uint8Array;
          epoch: string;
          bucket: number;
          value: number;
        }> = [];
        // SAMPLE the capped set in a fresh random order each poll (PRIV-CAP-4), so the per-poll verify
        // bound is fair rather than arrival-order-biased — a flooder cannot bury an honest cap behind
        // MAX_CAPS_VERIFIED_PER_POLL decodable-but-invalid ones.
        const order = shuffledIndices(caps.length);
        for (let k = 0; k < order.length && decoded.length < MAX_CAPS_VERIFIED_PER_POLL; k++) {
          const i = order[k] as number;
          const c = caps[i];
          if (c === undefined) continue;
          let pseudonym: Uint8Array;
          let proof: Uint8Array;
          try {
            pseudonym = cap.fromBase64Url(c.pseudonym);
            proof = cap.fromBase64Url(c.proof);
          } catch {
            continue; // malformed sealed cap — skip it (never throw out of the whole batch)
          }
          decoded.push({ pseudonym, proof, epoch: String(e), bucket, value: i });
        }
        return cap
          .filterVerifiedPresence(decoded, issuerKey, roomBlindIdBytes(roomBlindId), { nowMs })
          .map((v) => v.value);
      },
    };
  }
}
