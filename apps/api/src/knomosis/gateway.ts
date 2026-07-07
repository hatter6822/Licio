// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3 — the `knomosis-gateway` transport seam (gateway contract v0.4,
// HTTP/JSON + SSE; pinned in pin.config.json).  Licio's BFF is the gateway's
// first consumer: `POST /v1/actions` returns a SYNCHRONOUS verdict (no chain
// receipt; `seq` is null today), standing reads are eventual-consistent
// snapshots tagged `X-Knomosis-Seq` + a weak ETag, and events replay by
// cursor (`GET /v1/events?since=`) with a 409 `{oldestSeq}` gap signal that
// the consumer must treat as FAIL-CLOSED (full rebuild, never a silent skip).
//
// Three implementations of one interface:
//  - `FakeKnomosisGateway` — deterministic in-memory kernel for dev + tests:
//    real verdict/event/standing semantics (seq ordering, idempotency,
//    window truncation) with no network.
//  - `HttpKnomosisGateway` — fetch-based client with file-loaded bearer-token
//    service auth; an UNKNOWN verdict or malformed body is a typed
//    `protocol_error` (fail closed), never an accept.
//  - absent (gateway not configured) — every caller degrades closed.
//
// The gateway NEVER holds user keys and neither does this client: the signed
// action is forwarded as opaque bytes; no signing happens server-side.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface GatewaySignedAction {
  /** The EIP-712 message + signature exactly as the user's wallet produced. */
  message: Record<string, string>;
  signature: string;
  actionType: string;
  typedDataHash: string;
}

const gatewayVerdictSchema = z
  .object({
    accepted: z.boolean(),
    verdict: z.enum(['Ok', 'NotAdmissible', 'InsufficientBudget']),
    reason: z.string().max(500).optional(),
    admissionStage: z.string().max(64).optional(),
    /** Present but null today (gateway OQ-GW-6); never treated as a failure. */
    seq: z.string().regex(/^\d+$/).nullable(),
  })
  .strict();
export type GatewayVerdict = z.infer<typeof gatewayVerdictSchema>;

export type GatewaySubmitResult =
  | { kind: 'verdict'; verdict: GatewayVerdict }
  | { kind: 'unavailable'; detail: string }
  /** Unknown verdict / malformed body / contract violation → FAIL CLOSED. */
  | { kind: 'protocol_error'; detail: string };

const gatewayEventSchema = z
  .object({
    seq: z.string().regex(/^\d+$/),
    index: z.number().int().min(0),
    type: z.string().min(1).max(128),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type GatewayEvent = z.infer<typeof gatewayEventSchema>;

export type GatewayEventsResult =
  | { kind: 'events'; events: GatewayEvent[]; latestSeq: string | null }
  /** The cursor fell behind the retained window: an unknown range of possibly
   *  balance/freeze/governance-affecting events was lost → rebuild required. */
  | { kind: 'gap'; oldestSeq: string }
  | { kind: 'unavailable'; detail: string };

export interface GatewayStandingRead<T> {
  kind: 'ok';
  value: T;
  /** The eventual-consistency cursor this snapshot reflects. */
  knomosisSeq: string;
  etag: string | null;
}
export type GatewayReadResult<T> =
  | GatewayStandingRead<T>
  | { kind: 'not_modified' }
  | { kind: 'unavailable'; detail: string };

/** Balances: resource → decimal-string amount; absent cell reads "0". */
export type GatewayBalances = Record<string, string>;
export interface GatewayBudget {
  amount: string;
  /** Honest lower bound until the gateway's authoritative read path (G6). */
  isLowerBound: boolean;
}

export interface KnomosisGateway {
  submitAction(args: {
    signedAction: GatewaySignedAction;
    idempotencyKey: string;
  }): Promise<GatewaySubmitResult>;
  getBalances(actorId: string, etag?: string | null): Promise<GatewayReadResult<GatewayBalances>>;
  getBudget(actorId: string, etag?: string | null): Promise<GatewayReadResult<GatewayBudget>>;
  getEvents(sinceSeq: string | null, limit: number): Promise<GatewayEventsResult>;
}

// ---------------------------------------------------------------------------
// Deterministic in-memory fake (dev + tests)
// ---------------------------------------------------------------------------

export class FakeKnomosisGateway implements KnomosisGateway {
  #seq = 0n;
  #oldestRetainedSeq = 1n;
  readonly #events: GatewayEvent[] = [];
  readonly #balances = new Map<string, Map<string, bigint>>();
  readonly #budgets = new Map<string, bigint>();
  readonly #verdictByIdempotency = new Map<string, GatewayVerdict>();
  /** typed-data hashes the next submit should decline (test control). */
  readonly #declineHashes = new Set<string>();
  /** When true, every call reports `unavailable` (outage simulation). */
  offline = false;

  /** Test/dev control: make the kernel decline a specific action. */
  decline(typedDataHash: string): void {
    this.#declineHashes.add(typedDataHash);
  }

  /** Test/dev control: drop retained events up to (and incl.) `seq`. */
  truncateWindow(oldestRetainedSeq: string): void {
    this.#oldestRetainedSeq = BigInt(oldestRetainedSeq);
    const kept = this.#events.filter((e) => BigInt(e.seq) >= this.#oldestRetainedSeq);
    this.#events.length = 0;
    this.#events.push(...kept);
  }

  /** Test/dev control: emit a post-reorg revert event for an action. */
  emitRevert(typedDataHash: string, actorId: string): void {
    this.#push('knomosis.action.reverted', { typed_data_hash: typedDataHash, actor_id: actorId });
  }

  /** Test/dev control: emit an arbitrary event type (e.g. a future/unknown tag
   *  to exercise the fail-closed ingest halt). */
  emitRaw(type: string, payload: Record<string, unknown> = {}): void {
    this.#push(type, payload);
  }

  /** Test/dev control: seed an actor balance directly. */
  setBalance(actorId: string, resource: string, amount: string): void {
    const cells = this.#balances.get(actorId) ?? new Map<string, bigint>();
    cells.set(resource, BigInt(amount));
    this.#balances.set(actorId, cells);
  }

  #push(type: string, payload: Record<string, unknown>): GatewayEvent {
    this.#seq += 1n;
    const event: GatewayEvent = { seq: this.#seq.toString(), index: 0, type, payload };
    this.#events.push(event);
    return event;
  }

  async submitAction(args: {
    signedAction: GatewaySignedAction;
    idempotencyKey: string;
  }): Promise<GatewaySubmitResult> {
    if (this.offline) return { kind: 'unavailable', detail: 'gateway offline (simulated)' };

    const replay = this.#verdictByIdempotency.get(args.idempotencyKey);
    if (replay) return { kind: 'verdict', verdict: structuredClone(replay) };

    const { signedAction } = args;
    if (this.#declineHashes.has(signedAction.typedDataHash)) {
      const verdict: GatewayVerdict = {
        accepted: false,
        verdict: 'NotAdmissible',
        reason: 'declined by kernel precondition (simulated)',
        admissionStage: 'kernel',
        seq: null,
      };
      this.#verdictByIdempotency.set(args.idempotencyKey, verdict);
      return { kind: 'verdict', verdict: structuredClone(verdict) };
    }

    // Accepted: the post-reorg event stream carries the action through the
    // §23.5 happy path (accepted → settled → finalized) at successive seqs.
    const actorId = (signedAction.message['actor'] ?? 'unknown').toLowerCase();
    const base = { typed_data_hash: signedAction.typedDataHash, actor_id: actorId };
    this.#push('knomosis.action.accepted', base);
    this.#push('knomosis.action.settled', base);
    this.#push('knomosis.action.finalized', base);

    // Standing effect for deposits/contributions: credit the actor's cell.
    const amount = signedAction.message['amount'];
    const asset = signedAction.message['asset'];
    if (amount !== undefined && asset !== undefined && /^\d+$/.test(amount)) {
      const cells = this.#balances.get(actorId) ?? new Map<string, bigint>();
      cells.set(asset, (cells.get(asset) ?? 0n) + BigInt(amount));
      this.#balances.set(actorId, cells);
    }

    const verdict: GatewayVerdict = {
      accepted: true,
      verdict: 'Ok',
      admissionStage: 'kernel',
      seq: null,
    };
    this.#verdictByIdempotency.set(args.idempotencyKey, verdict);
    return { kind: 'verdict', verdict: structuredClone(verdict) };
  }

  async getBalances(
    actorId: string,
    etag?: string | null,
  ): Promise<GatewayReadResult<GatewayBalances>> {
    if (this.offline) return { kind: 'unavailable', detail: 'gateway offline (simulated)' };
    const cells = this.#balances.get(actorId.toLowerCase()) ?? new Map<string, bigint>();
    const value: GatewayBalances = {};
    for (const [resource, amount] of cells) value[resource] = amount.toString();
    const seq = this.#seq.toString();
    const currentEtag = `W/"bal-${actorId.toLowerCase()}-${seq}"`;
    if (etag !== undefined && etag !== null && etag === currentEtag) {
      return { kind: 'not_modified' };
    }
    return { kind: 'ok', value, knomosisSeq: seq, etag: currentEtag };
  }

  async getBudget(
    actorId: string,
    etag?: string | null,
  ): Promise<GatewayReadResult<GatewayBudget>> {
    if (this.offline) return { kind: 'unavailable', detail: 'gateway offline (simulated)' };
    const amount = (this.#budgets.get(actorId.toLowerCase()) ?? 0n).toString();
    const seq = this.#seq.toString();
    const currentEtag = `W/"bud-${actorId.toLowerCase()}-${seq}"`;
    if (etag !== undefined && etag !== null && etag === currentEtag) {
      return { kind: 'not_modified' };
    }
    return {
      kind: 'ok',
      value: { amount, isLowerBound: true },
      knomosisSeq: seq,
      etag: currentEtag,
    };
  }

  async getEvents(sinceSeq: string | null, limit: number): Promise<GatewayEventsResult> {
    if (this.offline) return { kind: 'unavailable', detail: 'gateway offline (simulated)' };
    const since = sinceSeq === null ? 0n : BigInt(sinceSeq);
    // A cursor strictly below the retained window minus one is a GAP: events
    // in (since, oldestRetained) were dropped and cannot be replayed.
    if (since + 1n < this.#oldestRetainedSeq) {
      return { kind: 'gap', oldestSeq: this.#oldestRetainedSeq.toString() };
    }
    const events = this.#events.filter((e) => BigInt(e.seq) > since).slice(0, limit);
    return {
      kind: 'events',
      events: events.map((e) => structuredClone(e)),
      latestSeq: this.#seq === 0n ? null : this.#seq.toString(),
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP client (service-facing; bearer-token auth; fail-closed parsing)
// ---------------------------------------------------------------------------

export interface HttpGatewayOptions {
  baseUrl: string;
  /** Service bearer token (file-loaded at boot; never logged). */
  bearerToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpKnomosisGateway implements KnomosisGateway {
  readonly #options: Required<Pick<HttpGatewayOptions, 'baseUrl' | 'bearerToken'>> & {
    fetchImpl: typeof fetch;
    timeoutMs: number;
  };

  constructor(options: HttpGatewayOptions) {
    this.#options = {
      baseUrl: options.baseUrl.replace(/\/$/, ''),
      bearerToken: options.bearerToken,
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: options.timeoutMs ?? 10_000,
    };
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response | { error: string }> {
    try {
      const response = await this.#options.fetchImpl(`${this.#options.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#options.bearerToken}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
      return response;
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'network error' };
    }
  }

  async submitAction(args: {
    signedAction: GatewaySignedAction;
    idempotencyKey: string;
  }): Promise<GatewaySubmitResult> {
    const response = await this.#request('POST', '/v1/actions', {
      body: args.signedAction,
      headers: { 'idempotency-key': args.idempotencyKey },
    });
    if ('error' in response) return { kind: 'unavailable', detail: response.error };
    if (response.status === 200) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: 'protocol_error', detail: 'unparseable verdict body' };
      }
      const parsed = gatewayVerdictSchema.safeParse(body);
      // An unknown verdict shape/byte is a PROTOCOL error — fail closed,
      // never optimistically accepted (gateway contract: unknown verdict ⇒ 502).
      if (!parsed.success) return { kind: 'protocol_error', detail: 'unknown verdict shape' };
      return { kind: 'verdict', verdict: parsed.data };
    }
    if (response.status === 400 || response.status === 413) {
      return { kind: 'protocol_error', detail: `gateway rejected the frame (${response.status})` };
    }
    return { kind: 'unavailable', detail: `gateway status ${response.status}` };
  }

  async #standingRead<T>(
    path: string,
    schema: z.ZodType<T>,
    etag?: string | null,
  ): Promise<GatewayReadResult<T>> {
    const response = await this.#request('GET', path, {
      headers: etag !== undefined && etag !== null ? { 'if-none-match': etag } : {},
    });
    if ('error' in response) return { kind: 'unavailable', detail: response.error };
    if (response.status === 304) return { kind: 'not_modified' };
    if (response.status !== 200) {
      return { kind: 'unavailable', detail: `gateway status ${response.status}` };
    }
    const knomosisSeq = response.headers.get('x-knomosis-seq');
    if (knomosisSeq === null || !/^\d+$/.test(knomosisSeq)) {
      return { kind: 'unavailable', detail: 'missing X-Knomosis-Seq' };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'unavailable', detail: 'unparseable standing body' };
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return { kind: 'unavailable', detail: 'invalid standing shape' };
    return {
      kind: 'ok',
      value: parsed.data,
      knomosisSeq,
      etag: response.headers.get('etag'),
    };
  }

  async getBalances(
    actorId: string,
    etag?: string | null,
  ): Promise<GatewayReadResult<GatewayBalances>> {
    return this.#standingRead(
      `/v1/actors/${encodeURIComponent(actorId)}/balances`,
      z.record(z.string(), z.string().regex(/^\d+$/)),
      etag,
    );
  }

  async getBudget(
    actorId: string,
    etag?: string | null,
  ): Promise<GatewayReadResult<GatewayBudget>> {
    return this.#standingRead(
      `/v1/actors/${encodeURIComponent(actorId)}/budget`,
      z.object({ amount: z.string().regex(/^\d+$/), isLowerBound: z.boolean() }).strict(),
      etag,
    );
  }

  async getEvents(sinceSeq: string | null, limit: number): Promise<GatewayEventsResult> {
    const since = sinceSeq === null ? '' : `since=${encodeURIComponent(sinceSeq)}&`;
    const response = await this.#request('GET', `/v1/events?${since}limit=${limit}`);
    if ('error' in response) return { kind: 'unavailable', detail: response.error };
    if (response.status === 409) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: 'unavailable', detail: 'unparseable 409 body' };
      }
      const parsed = z.object({ oldestSeq: z.string().regex(/^\d+$/) }).safeParse(body);
      if (!parsed.success) return { kind: 'unavailable', detail: 'invalid 409 shape' };
      return { kind: 'gap', oldestSeq: parsed.data.oldestSeq };
    }
    if (response.status !== 200) {
      return { kind: 'unavailable', detail: `gateway status ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'unavailable', detail: 'unparseable events body' };
    }
    const parsed = z
      .object({
        events: z.array(gatewayEventSchema).max(10_000),
        latestSeq: z.string().regex(/^\d+$/).nullable(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) return { kind: 'unavailable', detail: 'invalid events shape' };
    return { kind: 'events', events: parsed.data.events, latestSeq: parsed.data.latestSeq };
  }
}
