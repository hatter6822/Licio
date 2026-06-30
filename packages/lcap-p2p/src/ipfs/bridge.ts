// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The public-block IPFS bridge (OFFLINE_SPEC §22.7, §37.2, §21.4, §26.4,
// WS-R.15.7a/b).  A DEPENDENCY-FREE bridge: it fetches a public block from a
// configurable IPFS HTTP gateway and publishes one through a pinning HTTP API — no
// in-browser libp2p node, so the strict <15-dep / <200KB budget and the SBOM stay
// clean (the maintainer-approved posture).  Two invariants are structural:
//   - NO TRANSPORT TRUST: every fetched block is re-verified against its LCAP
//     `block_cid` (`verifyCid`) BEFORE any use — a gateway that returns wrong bytes is
//     rejected, so DHT interop never weakens hash verification.
//   - PUBLIC-ONLY: a block is publishable ONLY if its source record is `public`
//     visibility, not encrypted, and not taken down (`decideBlockPublish`); in_room /
//     private / ciphertext are structurally excluded, and a WS-J takedown halts
//     republication.

import { verifyCid } from '@licio/lcap';
import { ipfsCidForBlockCid } from './cid-map.js';
import {
  assertPublicGatewayEligible,
  type PublicGatewayEligibilityInput,
  type PublicGatewayRejectReason,
} from './public-gateway-guard.js';
import { type TakedownOracle, takedownRecheck } from './takedown.js';

export type BlockVisibility = 'public' | 'in_room' | 'private';

export interface BlockPublishInput {
  readonly visibility: BlockVisibility;
  /** Whether the block payload is ciphertext (private-room content). */
  readonly encrypted: boolean;
  /** Whether a WS-J takedown is in force for this block's source. */
  readonly takenDown: boolean;
}

export interface PublishDecision {
  readonly publishable: boolean;
  readonly reason: '' | 'not_public' | 'encrypted' | 'taken_down';
}

/**
 * The §37.2 public-only gate: a block reaches the public DHT only if its source record
 * is `public`, is not ciphertext, and is not taken down.  Every other case is refused
 * with the precise reason (auditable).
 */
export function decideBlockPublish(input: BlockPublishInput): PublishDecision {
  if (input.takenDown) return { publishable: false, reason: 'taken_down' };
  if (input.encrypted) return { publishable: false, reason: 'encrypted' };
  if (input.visibility !== 'public') return { publishable: false, reason: 'not_public' };
  return { publishable: true, reason: '' };
}

export interface IpfsBridgeConfig {
  /** An IPFS HTTP gateway base, e.g. `https://ipfs.io` (read path). */
  readonly gatewayUrl: string;
  /** A pinning/add HTTP endpoint that stores raw bytes and pins by CID (write path). */
  readonly pinningUrl?: string;
  /** Injectable fetch (defaults to the platform `fetch`); tests pass a fake. */
  readonly fetchFn?: typeof fetch;
  /**
   * The Gate-19 publish-time takedown re-check seam.  When set, `publishBlock` consults it
   * AT PUBLISH TIME (after the static decision, before any network/pin call) so a stale
   * `BlockPublishInput.takenDown` cannot bypass a takedown that landed since the input was
   * assembled.  `republish` REQUIRES this oracle and fails closed without it.  The DB-backed
   * implementation (a query over `takedown_requests`) is a later wave.
   */
  readonly takedownOracle?: TakedownOracle;
  /**
   * The hard ceiling on a single fetched block (§27.1).  The gateway is UNTRUSTED, so its response is
   * streamed against this cap — `Content-Length` is only a cheap first gate (forgeable/omittable);
   * the body is counted as it arrives and the read is CANCELLED the instant the cap is exceeded, so a
   * hostile gateway can never drive an unbounded allocation.  Defaults to {@link DEFAULT_MAX_BLOCK_BYTES}.
   */
  readonly maxBlockBytes?: number;
  /** Per-request network deadline (ms) for the gateway read + the pin POST — a slow/stuck gateway
   *  aborts rather than hanging the bridge.  Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The §27.1 single-object ceiling (16 MiB) — the same bound the LCAP reassembler enforces. */
export const DEFAULT_MAX_BLOCK_BYTES = 16 * 1024 * 1024;
/** The default gateway/pin network deadline. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type FetchOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'cid_mismatch' | 'gateway_error' | 'bad_cid' | 'oversize';
    };

export type PublishOutcome =
  | { readonly ok: true; readonly ipfsCid: string }
  | {
      readonly ok: false;
      readonly reason:
        | PublishDecision['reason']
        | PublicGatewayRejectReason
        | 'no_pinning_endpoint'
        | 'cid_mismatch'
        | 'bad_cid'
        | 'pin_error'
        | 'takedown_recheck_halt'
        | 'takedown_recheck_unreadable'
        | 'no_takedown_oracle';
    };

/**
 * The `body` type `fetch` accepts in THIS lib set, derived from `typeof fetch` itself rather
 * than the DOM-only literal `BodyInit`.  Under the DOM lib this resolves to `BodyInit`; under
 * `@types/node` (a node-only consumer re-typechecking this source via `exports.types`) it
 * resolves to undici's body type.  Deriving it keeps the pin body cast portable across both —
 * neither the DOM-only name nor a shared-buffer mismatch crosses the workspace boundary.
 */
type FetchBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>;

export class IpfsBridge {
  private readonly fetchFn: typeof fetch;
  private readonly maxBlockBytes: number;
  private readonly timeoutMs: number;
  constructor(private readonly config: IpfsBridgeConfig) {
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.maxBlockBytes = config.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  /** Map an LCAP `block_cid` to its DHT CID fail-closed (a non-block CID never bridges). */
  private toIpfsCid(blockCid: string): string | undefined {
    try {
      return ipfsCidForBlockCid(blockCid);
    } catch {
      return undefined;
    }
  }

  /** `fetch` with a bounded deadline — a slow/stuck gateway aborts instead of hanging. */
  private async fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read a response body bounded by `maxBlockBytes` — `Content-Length` is a cheap first gate, but the
   * stream is counted as it arrives and CANCELLED the instant the cap is exceeded, so a hostile
   * gateway that omits/forges the length still cannot drive an unbounded allocation.  Returns the
   * bytes, `'oversize'`, or `null` on a read error.
   */
  private async readBounded(response: Response): Promise<Uint8Array | 'oversize' | null> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBlockBytes) return 'oversize';
    const body = response.body;
    if (!body) {
      // A non-streaming response (e.g. a minimal fake): fall back to arrayBuffer + a size check.
      try {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return bytes.length > this.maxBlockBytes ? 'oversize' : bytes;
      } catch {
        return null;
      }
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > this.maxBlockBytes) {
          await reader.cancel().catch(() => undefined); // stop pulling — bound the memory
          return 'oversize';
        }
        chunks.push(value);
      }
    } catch {
      return null;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /**
   * Fetch a public block by its LCAP `block_cid` from the gateway, then RE-VERIFY the
   * returned bytes against the `block_cid` before returning them.  A gateway returning
   * the wrong bytes yields `cid_mismatch` (rejected — no transport trust); a non-block CID is
   * `bad_cid`; an over-cap / timed-out / unreadable response is bounded + typed, never thrown.
   */
  async fetchBlock(blockCid: string): Promise<FetchOutcome> {
    const ipfsCid = this.toIpfsCid(blockCid);
    if (ipfsCid === undefined) return { ok: false, reason: 'bad_cid' };
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.config.gatewayUrl}/ipfs/${ipfsCid}`);
    } catch {
      return { ok: false, reason: 'gateway_error' }; // network error OR the timeout abort
    }
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (!response.ok) return { ok: false, reason: 'gateway_error' };
    const bytes = await this.readBounded(response);
    if (bytes === 'oversize') return { ok: false, reason: 'oversize' };
    if (bytes === null) return { ok: false, reason: 'gateway_error' };
    // The non-negotiable re-verification: the gateway is untrusted.
    if (!(await verifyCid(blockCid, bytes))) return { ok: false, reason: 'cid_mismatch' };
    return { ok: true, bytes };
  }

  /**
   * Publish a public block (after the §37.2 gate passes) by pinning its bytes; returns
   * the IPFS CID others fetch it by.  Refuses any non-public/encrypted/taken-down block
   * structurally — the gate is enforced here, not merely advised.
   *
   * Defense-in-depth, in order: (1) the static `decision`; (2) the WS-S.4.4
   * public-gateway eligibility guard over the same signals (independent refusal even if a
   * caller hand-builds a `publishable: true` decision for non-public content); (3) the
   * Gate-19 publish-time takedown re-check, when an oracle is configured, so a stale
   * `takenDown` cannot bypass a takedown that landed since `decision` was computed; then
   * (4) the CID re-verification and pin.
   *
   * `gateway` carries the WS-S.4.4 signals and is REQUIRED: the independent public-gateway
   * eligibility check is the confidentiality backstop, so it must never run on a synthesized
   * all-clear input (which would make it a no-op for private content).  Every caller derives
   * these signals from the live content model and passes them explicitly.
   */
  async publishBlock(
    blockCid: string,
    bytes: Uint8Array,
    decision: PublishDecision,
    gateway: PublicGatewayEligibilityInput,
  ): Promise<PublishOutcome> {
    if (!decision.publishable) {
      return { ok: false, reason: decision.reason === '' ? 'not_public' : decision.reason };
    }
    // WS-S.4.4 — independent public-gateway eligibility (defense-in-depth), over the
    // caller-supplied live signals (never a synthesized all-clear).
    const eligibility = assertPublicGatewayEligible(gateway);
    if (!eligibility.eligible) {
      return { ok: false, reason: eligibility.reason === '' ? 'not_public' : eligibility.reason };
    }
    // Gate-19 — the publish-time takedown oracle is REQUIRED (PUB-IPFS-4: symmetric with `republish`),
    // so the caller-supplied static `takenDown` boolean is never the SOLE first-publish authority.
    if (!this.config.takedownOracle) return { ok: false, reason: 'no_takedown_oracle' };
    const recheck = await takedownRecheck(this.config.takedownOracle, blockCid);
    if (recheck !== 'clear') {
      return {
        ok: false,
        // Distinguish a genuine takedown (`halt`) from an unreadable oracle so the caller can AUDIT
        // them apart (PUB-API-PUBLISH-4); BOTH still refuse the pin (fail-closed).
        reason:
          recheck === 'oracle_error' ? 'takedown_recheck_unreadable' : 'takedown_recheck_halt',
      };
    }
    return this.pin(blockCid, bytes);
  }

  /**
   * Re-pin/re-announce an already-published block (the §22.7 republication loop's single
   * step).  Gate-19 makes this path STRICT: the takedown oracle is REQUIRED — without it
   * `republish` refuses (`no_takedown_oracle`), and if the oracle reports a takedown (or
   * throws) the re-pin is halted (`takedown_recheck_halt`).  A stale input can never carry
   * a taken-down block back onto the public DHT through this path.
   */
  async republish(
    blockCid: string,
    bytes: Uint8Array,
    gateway: PublicGatewayEligibilityInput,
  ): Promise<PublishOutcome> {
    if (!this.config.takedownOracle) return { ok: false, reason: 'no_takedown_oracle' };
    // PUB-API-PUBLISH-2 — re-pin is structurally public-only, symmetric with publishBlock: a block
    // whose content was NARROWED to non-public since it was first pinned is refused before any re-pin.
    const eligibility = assertPublicGatewayEligible(gateway);
    if (!eligibility.eligible) {
      return { ok: false, reason: eligibility.reason === '' ? 'not_public' : eligibility.reason };
    }
    const recheck = await takedownRecheck(this.config.takedownOracle, blockCid);
    if (recheck !== 'clear') {
      return {
        ok: false,
        reason:
          recheck === 'oracle_error' ? 'takedown_recheck_unreadable' : 'takedown_recheck_halt',
      };
    }
    return this.pin(blockCid, bytes);
  }

  /** Verify-then-pin: never pins bytes that do not hash to the announced `block_cid`. */
  private async pin(blockCid: string, bytes: Uint8Array): Promise<PublishOutcome> {
    if (!this.config.pinningUrl) return { ok: false, reason: 'no_pinning_endpoint' };
    const ipfsCid = this.toIpfsCid(blockCid);
    if (ipfsCid === undefined) return { ok: false, reason: 'bad_cid' };
    // Never publish bytes that do not hash to the block_cid we are announcing them under
    // (a caller bug would otherwise pin mislabeled content into the public DHT).
    if (!(await verifyCid(blockCid, bytes))) return { ok: false, reason: 'cid_mismatch' };
    try {
      // `bytes` (a `Uint8Array`) is a valid `fetch` request body; cast to the lib-derived
      // `FetchBody` so no DOM-only `BodyInit` name crosses the boundary (see its docstring).
      const response = await this.fetchWithTimeout(this.config.pinningUrl, {
        method: 'POST',
        body: bytes as unknown as FetchBody,
        headers: { 'content-type': 'application/octet-stream', 'x-ipfs-cid': ipfsCid },
      });
      if (!response.ok) return { ok: false, reason: 'pin_error' };
    } catch {
      return { ok: false, reason: 'pin_error' }; // network error OR the timeout abort
    }
    return { ok: true, ipfsCid };
  }
}
