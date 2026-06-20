// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exchange request/response assembly + status handling (OFFLINE_SPEC §16.3,
// §16.4, §16.5, WS-R.6.2).  An exchange carries the (logically-first) pulse plus
// interests, acks, an optional push pack, and wants one way; the pulse, a status,
// accepted-push statuses, offers, an optional response pack, receipts, and wants
// the other.  The client honors the `status` enum verbatim: `ok`/`partial`
// proceed, `rate_limited`/`retry_later` back off (honoring `retry_after_ms`),
// `auth_required` re-authenticates.  Pure assembly + a fail-closed validate.

import type { ObjectStatusV2 } from '../pack/status.js';
import type { ReceiptRecordV2 } from '../schemas/receipt.js';
import {
  type ExchangeBudgetV2,
  type ExchangeRequestV2,
  type ExchangeResponseV2,
  type ExchangeStatus,
  type ExchangeWarningV2,
  exchangeRequestV2Schema,
  exchangeResponseV2Schema,
  type InterestDescriptorV2,
  type ObjectSummaryV2,
  type SyncPulseV2,
  type WantRequestV2,
} from '../schemas/sync.js';

/** Build + fail-closed-validate an `ExchangeRequestV2` (§16.3). */
export function buildExchangeRequest(params: {
  readonly pulse: SyncPulseV2;
  readonly interests: readonly InterestDescriptorV2[];
  readonly knownSummaries?: readonly ObjectSummaryV2[];
  readonly ackReceipts?: readonly ReceiptRecordV2[];
  readonly pushPack?: Uint8Array;
  readonly want?: readonly WantRequestV2[];
}): ExchangeRequestV2 {
  const request: Record<string, unknown> = {
    pulse: params.pulse,
    interests: [...params.interests],
  };
  if (params.knownSummaries !== undefined) request['known_summaries'] = [...params.knownSummaries];
  if (params.ackReceipts !== undefined) request['ack_receipts'] = [...params.ackReceipts];
  if (params.pushPack !== undefined) request['push_pack'] = params.pushPack;
  if (params.want !== undefined) request['want'] = [...params.want];
  return exchangeRequestV2Schema.parse(request);
}

/** Build + fail-closed-validate an `ExchangeResponseV2` (§16.4). */
export function buildExchangeResponse(params: {
  readonly pulse: SyncPulseV2;
  readonly status: ExchangeStatus;
  readonly acceptedPush?: readonly ObjectStatusV2[];
  readonly wantedFromClient?: readonly WantRequestV2[];
  readonly offerSummary?: readonly ObjectSummaryV2[];
  readonly responsePack?: Uint8Array;
  readonly receipts?: readonly ReceiptRecordV2[];
  readonly retryAfterMs?: number;
  readonly warnings?: readonly ExchangeWarningV2[];
}): ExchangeResponseV2 {
  const response: Record<string, unknown> = {
    pulse: params.pulse,
    status: params.status,
  };
  if (params.acceptedPush !== undefined) response['accepted_push'] = [...params.acceptedPush];
  if (params.wantedFromClient !== undefined) {
    response['wanted_from_client'] = [...params.wantedFromClient];
  }
  if (params.offerSummary !== undefined) response['offer_summary'] = [...params.offerSummary];
  if (params.responsePack !== undefined) response['response_pack'] = params.responsePack;
  if (params.receipts !== undefined) response['receipts'] = [...params.receipts];
  if (params.retryAfterMs !== undefined) response['retry_after_ms'] = params.retryAfterMs;
  if (params.warnings !== undefined) response['warnings'] = [...params.warnings];
  return exchangeResponseV2Schema.parse(response);
}

/** The client's next action for a response status (§16.4). */
export type ExchangeDirective = 'proceed' | 'continue' | 'retry' | 'reauthenticate';

/** Map a response `status` to the client's directive (honored verbatim, §16.4). */
export function clientDirectiveForStatus(status: ExchangeStatus): ExchangeDirective {
  switch (status) {
    case 'ok':
      return 'proceed';
    case 'partial':
      return 'continue'; // more to fetch — re-exchange with the remaining wants
    case 'rate_limited':
    case 'retry_later':
      return 'retry';
    case 'auth_required':
      return 'reauthenticate';
  }
}

/** True iff the client should back off and retry later (honoring `retry_after_ms`). */
export function shouldRetry(status: ExchangeStatus): boolean {
  return status === 'rate_limited' || status === 'retry_later';
}

/** True iff the exchange completed with nothing further outstanding. */
export function exchangeComplete(status: ExchangeStatus): boolean {
  return status === 'ok';
}

/** True iff a pack of `byteLength` fits the budget side it travels on (§16.5). */
export function packWithinBudget(
  byteLength: number,
  budget: ExchangeBudgetV2,
  side: 'request' | 'response',
): boolean {
  const cap = side === 'request' ? budget.max_request_bytes : budget.max_response_bytes;
  return byteLength <= cap;
}
