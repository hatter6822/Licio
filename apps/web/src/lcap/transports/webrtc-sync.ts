// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.10 — the BIDIRECTIONAL WebRTC §16 exchange driver.  Over ONE duplex data channel both
// peers act as BOTH requester and responder (otherwise — as before — both send requests and
// neither answers, so no content moves).  This driver classifies every inbound message
// (`handleInboundExchangeMessage`): a peer REQUEST is served (its wants repacked + its push
// ingested) and the reply ferried back; our RESPONSE is CID-verified + committed into the local
// `lcap_v2` store.  It runs over the raw `DataChannelLike` (reusing the `@licio/lcap-p2p`
// ≤16 KiB SCTP fragmentation/reassembly), so the heavy P2P core stays dynamic-import-only.
//
// SECURITY: the channel confers NO trust — every served/pushed frame is re-verified by CID in the
// ingest path (§18.4); content is PUBLIC-only; reassembly is bounded by the §27 DoS cap.

import type { DataChannelLike } from '@licio/lcap-p2p';
import {
  buildClientExchangeRequest,
  type CommitCounts,
  type ExchangeScope,
  handleInboundExchangeMessage,
} from '../exchange.js';

/** Coerce a datachannel payload (ArrayBuffer | Uint8Array | string) to bytes. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return null;
}

export interface WebrtcExchangeParams {
  readonly db: IDBDatabase;
  /** The established duplex data channel (raw — not the requester-only `WebrtcTransport`). */
  readonly channel: DataChannelLike;
  /** A pre-built request (else one is built from the local quarantine gaps). */
  readonly request?: Uint8Array;
  /** The §22.5 sharing scope — what we may serve/push (public-only, room/priority filtered). */
  readonly scope?: ExchangeScope;
  readonly signal?: AbortSignal;
  /** Wall-clock cap on waiting for our response before resolving (the peer may answer slowly). */
  readonly timeoutMs?: number;
}

export interface WebrtcExchangeResult {
  /** The commit counts when the peer served us content, or `null` (no response / nothing served). */
  readonly ingested: CommitCounts | null;
  /** True if we served at least one inbound peer request (the responder half ran). */
  readonly served: boolean;
}

/**
 * Drive ONE bidirectional §16 exchange over an open data channel: send our request, serve any
 * inbound peer requests, and ingest the peer's served response.  Resolves when our response is
 * ingested, the channel closes, the signal aborts, or the timeout elapses — whichever first.
 */
export async function runWebrtcBidirectionalExchange(
  params: WebrtcExchangeParams,
): Promise<WebrtcExchangeResult> {
  const p2p = await import('@licio/lcap-p2p');
  const reassembler = new p2p.FragmentReassembler();
  // After the FIRST direction completes, give the OTHER this long to request/answer before we
  // settle + close — so a peer that answers our request BEFORE sending its own still gets served
  // (the carrier stays genuinely bidirectional under asymmetric timing).
  const GRACE_MS = 1_500;
  let messageId = 0;
  let served = false;
  let gotResponse = false;
  let ingestedResult: CommitCounts | null = null;
  let settled = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (r: WebrtcExchangeResult) => void;
  const done = new Promise<WebrtcExchangeResult>((resolve) => {
    resolveResult = resolve;
  });
  const settle = (ingested: CommitCounts | null): void => {
    if (settled) return;
    settled = true;
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    resolveResult({ ingested, served });
  };
  // Settle once BOTH directions have run; else open a grace window after the first completes.
  const maybeSettle = (): void => {
    if (settled) return;
    if (gotResponse && served) settle(ingestedResult);
    else if (graceTimer === undefined)
      graceTimer = setTimeout(() => settle(ingestedResult), GRACE_MS);
  };

  const aborted = (): boolean => params.signal?.aborted ?? false;
  const sendMessage = (bytes: Uint8Array): void => {
    if (settled || aborted()) return; // never transmit after a cancel/settle
    for (const fragment of p2p.fragmentMessage(bytes, messageId++)) {
      if (params.channel.readyState !== 'open') return;
      params.channel.send(fragment);
    }
  };

  params.channel.onmessage = (event): void => {
    const data = toBytes(event.data);
    if (!data) return;
    let complete: Uint8Array | null;
    try {
      complete = reassembler.accept(data);
    } catch {
      return; // a fragmentation/bomb violation — drop (fail-closed, §27)
    }
    if (!complete) return; // mid-message
    void handleInboundExchangeMessage(params.db, complete, params.scope).then((out) => {
      if (out.wasRequest) {
        served = true;
        if (out.reply) sendMessage(out.reply); // serve the peer
      } else {
        gotResponse = true; // the peer's response to OUR request — ingested
        ingestedResult = out.ingested;
      }
      maybeSettle();
    });
  };

  params.channel.onclose = (): void => settle(ingestedResult);
  if (params.signal) {
    if (params.signal.aborted) settle(null);
    else params.signal.addEventListener('abort', () => settle(null), { once: true });
  }
  const timer = setTimeout(() => settle(ingestedResult), params.timeoutMs ?? 20_000);

  // Send our request advertising our gaps so the peer serves them — but NOT if a cancel fired
  // while the request was being built (page unload / mode change), so no payload leaves post-abort.
  const request =
    params.request ?? (await buildClientExchangeRequest(params.db, 'relay', params.scope));
  if (!settled && !aborted()) sendMessage(request);

  const result = await done;
  clearTimeout(timer);
  return result;
}
