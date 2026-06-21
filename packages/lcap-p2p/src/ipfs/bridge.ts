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
}

export type FetchOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'not_found' | 'cid_mismatch' | 'gateway_error' };

export type PublishOutcome =
  | { readonly ok: true; readonly ipfsCid: string }
  | {
      readonly ok: false;
      readonly reason: PublishDecision['reason'] | 'no_pinning_endpoint' | 'pin_error';
    };

export class IpfsBridge {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly config: IpfsBridgeConfig) {
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Fetch a public block by its LCAP `block_cid` from the gateway, then RE-VERIFY the
   * returned bytes against the `block_cid` before returning them.  A gateway returning
   * the wrong bytes yields `cid_mismatch` (rejected — no transport trust).
   */
  async fetchBlock(blockCid: string): Promise<FetchOutcome> {
    const ipfsCid = ipfsCidForBlockCid(blockCid); // throws on non-block CIDs
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.gatewayUrl}/ipfs/${ipfsCid}`);
    } catch {
      return { ok: false, reason: 'gateway_error' };
    }
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (!response.ok) return { ok: false, reason: 'gateway_error' };
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The non-negotiable re-verification: the gateway is untrusted.
    if (!(await verifyCid(blockCid, bytes))) return { ok: false, reason: 'cid_mismatch' };
    return { ok: true, bytes };
  }

  /**
   * Publish a public block (after the §37.2 gate passes) by pinning its bytes; returns
   * the IPFS CID others fetch it by.  Refuses any non-public/encrypted/taken-down block
   * structurally — the gate is enforced here, not merely advised.
   */
  async publishBlock(
    blockCid: string,
    bytes: Uint8Array,
    decision: PublishDecision,
  ): Promise<PublishOutcome> {
    if (!decision.publishable) {
      return { ok: false, reason: decision.reason === '' ? 'not_public' : decision.reason };
    }
    if (!this.config.pinningUrl) return { ok: false, reason: 'no_pinning_endpoint' };
    const ipfsCid = ipfsCidForBlockCid(blockCid);
    try {
      const response = await this.fetchFn(this.config.pinningUrl, {
        method: 'POST',
        body: bytes as BodyInit,
        headers: { 'content-type': 'application/octet-stream', 'x-ipfs-cid': ipfsCid },
      });
      if (!response.ok) return { ok: false, reason: 'pin_error' };
    } catch {
      return { ok: false, reason: 'pin_error' };
    }
    return { ok: true, ipfsCid };
  }
}
