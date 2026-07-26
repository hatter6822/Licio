// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.6 (client) — the server-blind rendezvous transport the live WebRTC carrier
// (`connect-peer.ts`) drives.  It speaks the four `POST /v1/private-rendezvous/*`
// endpoints (announce / poll / signal / signal-poll), all of which carry ONLY opaque
// blind ids + ciphertext + a clamped TTL — the server reads no SDP/ICE, no room, no
// account (§15.3.1).  The transport is an injectable seam: the browser uses the
// `fetch`-backed implementation; node tests inject an in-memory pair.
//
// Every response is zod-validated before use (the project's trust-boundary rule).  The
// blind-id / ciphertext shapes mirror the server schemas in
// `apps/api/src/private-rendezvous/stores.ts`; a drift would fail the parse, not leak.

import { RENDEZVOUS_MAX_RECORDS_PER_POLL } from '@licio/shared';
import { z } from 'zod';

// --- the opaque wire records (mirror the server, validated on the way IN) ----------

const blindIdSchema = z.string().min(1).max(512);
const ciphertextSchema = z
  .string()
  .min(1)
  .max(128 * 1024);

/** A presence record returned by `poll` (opaque to the server). */
export const presenceRecordSchema = z
  .object({
    room_blind_id: blindIdSchema,
    peer_blind_id: blindIdSchema,
    encrypted_announcement: ciphertextSchema,
    expires_at: z.number().int().nonnegative(),
  })
  .strict();
export type PresenceRecord = z.infer<typeof presenceRecordSchema>;

/** A queued signaling blob returned by `signalPoll` (opaque to the server). */
export const wireSignalSchema = z
  .object({
    room_blind_id: blindIdSchema,
    sender_blind_id: blindIdSchema,
    recipient_blind_id: blindIdSchema,
    ciphertext: ciphertextSchema,
    expires_at: z.number().int().nonnegative(),
  })
  .strict();
export type WireSignal = z.infer<typeof wireSignalSchema>;

const pollResponseSchema = z
  .object({ records: z.array(presenceRecordSchema).max(RENDEZVOUS_MAX_RECORDS_PER_POLL) })
  .strict();
const signalPollResponseSchema = z
  .object({ signals: z.array(wireSignalSchema).max(RENDEZVOUS_MAX_RECORDS_PER_POLL) })
  .strict();

/**
 * The transport the carrier drives.  `announce`/`signal` publish an opaque record;
 * `poll`/`signalPoll` read the bounded, opaque lists (poll is never an existence
 * oracle — it returns `[]` for an unknown blind id, §15.3.1).
 */
export interface RendezvousTransport {
  announce(record: PresenceRecord): Promise<void>;
  poll(roomBlindId: string): Promise<PresenceRecord[]>;
  signal(signal: WireSignal): Promise<void>;
  signalPoll(peerBlindId: string): Promise<WireSignal[]>;
}

// --- the fetch-backed browser transport --------------------------------------------

/** The fetch surface (injectable so the carrier stays testable without a global). */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

async function postJson(fetchImpl: FetchLike, url: string, body: unknown): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`rendezvous ${url}: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * The production rendezvous transport over `POST /v1/private-rendezvous/*`.  These
 * endpoints are sessionless + CSRF-exempt by design (opaque-only payloads), so no
 * token plumbing is needed; abuse is bounded by the server's IP-free rate limits.
 */
export function httpRendezvousTransport(
  fetchImpl: FetchLike,
  baseUrl = '/v1/private-rendezvous',
): RendezvousTransport {
  return {
    async announce(record) {
      await postJson(fetchImpl, `${baseUrl}/announce`, record);
    },
    async poll(roomBlindId) {
      const data = await postJson(fetchImpl, `${baseUrl}/poll`, { room_blind_id: roomBlindId });
      return pollResponseSchema.parse(data).records;
    },
    async signal(signal) {
      await postJson(fetchImpl, `${baseUrl}/signal`, signal);
    },
    async signalPoll(peerBlindId) {
      const data = await postJson(fetchImpl, `${baseUrl}/signal/poll`, {
        peer_blind_id: peerBlindId,
      });
      return signalPollResponseSchema.parse(data).signals;
    },
  };
}
