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
import { devWarn } from '../../lib/dev-log.js';
import {
  buildClientExchangeRequest,
  type CommitCounts,
  type ExchangeScope,
  handleInboundExchangeMessage,
  responsePrivacyLabel,
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

  // SCTP backpressure (§22.6, PUB-WEB-CARRIERS-BACKPRESSURE): the LIVE bidirectional carrier drives
  // the RAW DataChannelLike (not the requester-only `WebrtcTransport`), so it must apply the same
  // backpressure `WebrtcTransport.sendSerial` does — sending a multi-MiB reply as hundreds of
  // back-to-back fragments overruns the SCTP send buffer and `channel.send` throws OperationError
  // mid-stream, truncating the message the peer's reassembler then (correctly) rejects.
  const DRAIN_HIGH_WATER = 8 * 1024 * 1024;
  const DRAIN_LOW_WATER = 1 * 1024 * 1024;
  const MAX_DRAIN_WAITS = 30; // ≈60 s of 2 s waits before declaring the channel stuck
  let drainWaiters: Array<() => void> = [];
  const wakeDrainWaiters = (): void => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const wake of waiters) wake();
  };
  const channelWithDrain = params.channel as DataChannelLike & {
    bufferedAmount?: number;
    bufferedAmountLowThreshold?: number;
    onbufferedamountlow?: (() => void) | null;
  };
  if ('bufferedAmountLowThreshold' in channelWithDrain) {
    channelWithDrain.bufferedAmountLowThreshold = DRAIN_LOW_WATER;
    channelWithDrain.onbufferedamountlow = () => wakeDrainWaiters();
  }
  const waitForDrainEvent = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let done2 = false;
      const finish = (): void => {
        if (done2) return;
        done2 = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 2_000); // safety timeout: never hang if the event is missed
      drainWaiters.push(finish);
    });
  const awaitDrain = async (): Promise<void> => {
    if (typeof channelWithDrain.bufferedAmount !== 'number') return; // a fake/non-buffering channel
    let waits = 0;
    while (
      channelWithDrain.readyState === 'open' &&
      (channelWithDrain.bufferedAmount ?? 0) > DRAIN_HIGH_WATER
    ) {
      if (++waits > MAX_DRAIN_WAITS) return; // stuck — stop waiting; the send below fails on the full/closed channel
      await waitForDrainEvent();
    }
  };

  // Single-flight + backpressured: a concurrent send awaits the in-flight one so two messages'
  // fragments never interleave on the one ordered datachannel (which the receiver — one in-flight
  // message at a time — would reject), and each fragment waits for the SCTP buffer to drain first.
  let sendChain: Promise<void> = Promise.resolve();
  const sendMessage = (bytes: Uint8Array): void => {
    sendChain = sendChain
      .then(async () => {
        if (settled || aborted()) return; // never transmit after a cancel/settle
        const id = messageId++;
        for (const fragment of p2p.fragmentMessage(bytes, id)) {
          await awaitDrain();
          if (settled || aborted() || params.channel.readyState !== 'open') return;
          params.channel.send(fragment);
        }
      })
      .catch((error) => devWarn('WebRTC fragment send failed', error));
  };

  params.channel.onmessage = (event): void => {
    // A cancel / timeout that already settled this exchange must do NO further inbound work — else a
    // message completing just before settle would still commit the peer's response/push into
    // IndexedDB after the UI owner is gone (#W).
    if (settled || aborted()) return;
    const data = toBytes(event.data);
    if (!data) return;
    let complete: Uint8Array | null;
    try {
      complete = reassembler.accept(data);
    } catch {
      return; // a fragmentation/bomb violation — drop (fail-closed, §27)
    }
    if (!complete) return; // mid-message
    // Gate BOTH store writes (the responder's push ingest AND the requester's response ingest) on a
    // LIVE check, so a cancel/timeout that fires mid-handle does not still commit the peer's pack —
    // the post-await check below can only suppress counting/replying, not undo a commit (#AH).
    void handleInboundExchangeMessage(
      params.db,
      complete,
      params.scope,
      () => !settled && !aborted(),
    )
      .then(async (out) => {
        if (settled || aborted()) return; // settled WHILE ingesting — don't reply / count the result
        if (out.wasRequest) {
          served = true; // we handled the peer's request (whether or not the reply is carriable)
          if (out.reply) {
            // Structural public-only carriage gate on the RESPONDER leg (PUB-RESPONDER-PUBLIC-ONLY):
            // WEBRTC is carriesPrivate:false, so NEVER ferry a non-public reply back over the
            // datachannel — symmetric with the courier + the request-leg gate.  Fail closed (drop).
            if ((await responsePrivacyLabel(out.reply)) === 'public') sendMessage(out.reply);
          }
        } else {
          gotResponse = true; // the peer's response to OUR request — ingested
          ingestedResult = out.ingested;
        }
        maybeSettle();
      })
      .catch((error) => {
        // Serving/ingesting can reject (IndexedDB quota/transaction failure, repacking error).  A
        // fire-and-forget promise with no handler would surface an UNHANDLED rejection AND leave the
        // round hanging to the timeout — record it and let maybeSettle finish the round promptly (#AB).
        devWarn('inbound WebRTC exchange message failed', error);
        if (!settled && !aborted()) maybeSettle();
      });
  };

  params.channel.onclose = (): void => {
    wakeDrainWaiters(); // unblock any send parked on SCTP backpressure so it observes the close
    settle(ingestedResult);
  };
  // A NAMED handler so it is removed when the round settles by ANY path — otherwise a `{ once: true }`
  // listener that never fires (the round completed normally) accumulates on a reused session-scoped
  // signal across many rounds (PUB-WEB-CARRIERS-5).
  const onAbort = (): void => settle(null);
  if (params.signal) {
    if (params.signal.aborted) settle(null);
    else params.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => settle(ingestedResult), params.timeoutMs ?? 20_000);

  // Send our request advertising our gaps so the peer serves them — but NOT if a cancel fired
  // while the request was being built (page unload / mode change), so no payload leaves post-abort.
  const request =
    params.request ?? (await buildClientExchangeRequest(params.db, 'relay', params.scope));
  if (!settled && !aborted()) sendMessage(request);

  const result = await done;
  clearTimeout(timer);
  params.signal?.removeEventListener('abort', onAbort);
  return result;
}
