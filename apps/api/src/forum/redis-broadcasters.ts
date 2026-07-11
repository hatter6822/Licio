// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Redis pub/sub bindings for the live fan-out ports — the multi-instance
// production adapters behind the SAME `CommentBroadcaster` / `DebateBroadcaster`
// interfaces the in-memory adapters satisfy: a frame published on one instance
// reaches SSE subscribers held by every other, so live comments and debate-arena
// co-editing no longer partition by which replica a client's stream landed on.
//
// The boundary guarantees hold ACROSS the transport: frames are re-validated
// through the same zod schemas as the in-memory broadcasters on BOTH sides of
// the wire (publish + deliver), so a corrupted or non-conforming message is
// dropped, never dispatched (fail closed) — no scores, raw attention fields,
// wallet/payment state, or per-viewer flags can ride the channel.
//
// One SHARED subscriber connection serves both adapters (a Redis connection in
// subscriber mode cannot issue other commands), with per-channel ref-counted
// SUBSCRIBE/UNSUBSCRIBE so an idle process holds no channel subscriptions.
import {
  contributionPublicSchema,
  type DebateArenaPublic,
  debateArenaPublicSchema,
} from '@licio/shared';
import type IORedis from 'ioredis';
import type {
  CommentBroadcaster,
  CommentFrame,
  CommentFrameHandler,
} from './comment-broadcaster.js';
import type { DebateBroadcaster, DebateFrameHandler } from './debate-broadcaster.js';

/** Per-channel ref-counted fan-in over ONE subscriber-mode Redis connection.
 *  `subscribe` resolves only after the channel's SUBSCRIBE is ACKED by Redis,
 *  so a caller that awaits it before taking a replay snapshot can never lose
 *  a message published in the subscribe/ack gap (Redis pub/sub drops, it
 *  never buffers). */
export class RefCountedSubscriber {
  readonly #sub: IORedis;
  readonly #onError: (err: unknown) => void;
  readonly #handlers = new Map<string, Set<(message: string) => void>>();
  /** The channel's in-flight/completed SUBSCRIBE ack (shared by ref-holders). */
  readonly #ready = new Map<string, Promise<unknown>>();
  #wired = false;

  constructor(sub: IORedis, onError: (err: unknown) => void = () => {}) {
    this.#sub = sub;
    this.#onError = onError;
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    if (!this.#wired) {
      this.#sub.on('message', (incoming: string, message: string) => {
        const set = this.#handlers.get(incoming);
        if (!set) return;
        for (const h of set) h(message);
      });
      this.#wired = true;
    }
    let set = this.#handlers.get(channel);
    if (!set) {
      set = new Set();
      this.#handlers.set(channel, set);
      this.#ready.set(
        channel,
        this.#sub.subscribe(channel).catch((err) => this.#onError(err)),
      );
    }
    set.add(handler);
    const unsubscribe = (): void => {
      const current = this.#handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.#handlers.delete(channel);
        this.#ready.delete(channel);
        void this.#sub.unsubscribe(channel).catch(this.#onError);
      }
    };
    await this.#ready.get(channel);
    return unsubscribe;
  }
}

const COMMENT_CHANNEL_PREFIX = 'licio:comments:';
const DEBATE_CHANNEL_PREFIX = 'licio:debate:';

export class RedisCommentBroadcaster implements CommentBroadcaster {
  readonly #pub: IORedis;
  readonly #subscriber: RefCountedSubscriber;
  readonly #onError: (err: unknown) => void;

  constructor(
    pub: IORedis,
    subscriber: RefCountedSubscriber,
    onError: (err: unknown) => void = () => {},
  ) {
    this.#pub = pub;
    this.#subscriber = subscriber;
    this.#onError = onError;
  }

  publish(threadId: string, frame: CommentFrame): void {
    // Same validation + eventId derivation as the in-memory adapter.
    const parsed = contributionPublicSchema.safeParse(frame.contribution);
    if (!parsed.success || parsed.data.thread_id !== threadId) return;
    const validated: CommentFrame = {
      eventId: parsed.data.contribution_id,
      contribution: parsed.data,
    };
    void this.#pub
      .publish(`${COMMENT_CHANNEL_PREFIX}${threadId}`, JSON.stringify(validated))
      .catch(this.#onError);
  }

  async subscribe(threadId: string, handler: CommentFrameHandler): Promise<() => void> {
    return this.#subscriber.subscribe(`${COMMENT_CHANNEL_PREFIX}${threadId}`, (message) => {
      let contribution: CommentFrame['contribution'];
      try {
        const raw = JSON.parse(message) as { contribution?: unknown };
        const parsed = contributionPublicSchema.safeParse(raw.contribution);
        if (!parsed.success || parsed.data.thread_id !== threadId) return; // fail closed
        contribution = parsed.data;
      } catch {
        return; // a malformed message is dropped, never dispatched
      }
      Promise.resolve(handler({ eventId: contribution.contribution_id, contribution })).catch(
        () => {
          // Subscribers own their transport; one failed write must not break fan-out.
        },
      );
    });
  }
}

export class RedisDebateBroadcaster implements DebateBroadcaster {
  readonly #pub: IORedis;
  readonly #subscriber: RefCountedSubscriber;
  readonly #onError: (err: unknown) => void;

  constructor(
    pub: IORedis,
    subscriber: RefCountedSubscriber,
    onError: (err: unknown) => void = () => {},
  ) {
    this.#pub = pub;
    this.#subscriber = subscriber;
    this.#onError = onError;
  }

  publish(debateId: string, arena: DebateArenaPublic): void {
    const parsed = debateArenaPublicSchema.safeParse(arena);
    if (!parsed.success || parsed.data.debate_id !== debateId) return;
    void this.#pub
      .publish(`${DEBATE_CHANNEL_PREFIX}${debateId}`, JSON.stringify(parsed.data))
      .catch(this.#onError);
  }

  async subscribe(debateId: string, handler: DebateFrameHandler): Promise<() => void> {
    return this.#subscriber.subscribe(`${DEBATE_CHANNEL_PREFIX}${debateId}`, (message) => {
      let arena: DebateArenaPublic;
      try {
        const parsed = debateArenaPublicSchema.safeParse(JSON.parse(message));
        if (!parsed.success || parsed.data.debate_id !== debateId) return; // fail closed
        arena = parsed.data;
      } catch {
        return; // a malformed message is dropped, never dispatched
      }
      Promise.resolve(handler({ eventId: arena.updated_at, arena })).catch(() => {
        // Subscribers own their transport; one failed write must not break fan-out.
      });
    });
  }
}
