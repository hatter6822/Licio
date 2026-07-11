// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A failed SUBSCRIBE must not masquerade as a live channel (PR #131 review):
// the awaiting caller fails CLOSED (its SSE stream errors and the client
// reconnects, rather than holding a stream that never receives cross-replica
// frames), the broken attempt is not cached, and the next subscriber re-issues
// the SUBSCRIBE.
import type IORedis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { RefCountedSubscriber } from '../forum/redis-broadcasters.js';

type MessageListener = (channel: string, message: string) => void;

function stubSub(subscribe: (channel: string) => Promise<unknown>): {
  sub: IORedis;
  emit: MessageListener;
  subscribeMock: ReturnType<typeof vi.fn>;
} {
  let listener: MessageListener = () => {};
  const subscribeMock = vi.fn(subscribe);
  const sub = {
    on: (event: string, cb: MessageListener) => {
      if (event === 'message') listener = cb;
    },
    subscribe: subscribeMock,
    unsubscribe: vi.fn(async () => 1),
  } as unknown as IORedis;
  return { sub, emit: (channel, message) => listener(channel, message), subscribeMock };
}

describe('RefCountedSubscriber SUBSCRIBE failure', () => {
  it('rejects the awaiting subscriber, retries for the next one, then delivers', async () => {
    let calls = 0;
    const { sub, emit, subscribeMock } = stubSub(async () => {
      calls += 1;
      if (calls === 1) throw new Error('redis reconnecting');
      return 1;
    });
    const errors: unknown[] = [];
    const subscriber = new RefCountedSubscriber(sub, (err) => errors.push(err));

    await expect(subscriber.subscribe('licio:comments:t1', () => {})).rejects.toThrow(
      'redis reconnecting',
    );
    expect(errors).toHaveLength(1);

    // The failed attempt was not cached: the next subscriber re-issues the
    // SUBSCRIBE and lands on a genuinely live channel.
    const received: string[] = [];
    const unsubscribe = await subscriber.subscribe('licio:comments:t1', (message) =>
      received.push(message),
    );
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    emit('licio:comments:t1', 'frame-1');
    expect(received).toEqual(['frame-1']);
    unsubscribe();
  });

  it('rejects EVERY caller sharing the failed attempt (no orphaned handlers)', async () => {
    let calls = 0;
    let rejectFirst!: (err: Error) => void;
    const gate = new Promise((_, reject) => {
      rejectFirst = reject;
    });
    const { sub, emit, subscribeMock } = stubSub(() => {
      calls += 1;
      return calls === 1 ? gate : Promise.resolve(1);
    });
    const subscriber = new RefCountedSubscriber(sub);

    const received: string[] = [];
    const a = subscriber.subscribe('licio:debate:d1', (message) => received.push(`a:${message}`));
    const b = subscriber.subscribe('licio:debate:d1', (message) => received.push(`b:${message}`));
    rejectFirst(new Error('connection lost'));
    await expect(a).rejects.toThrow('connection lost');
    await expect(b).rejects.toThrow('connection lost');
    expect(subscribeMock).toHaveBeenCalledTimes(1); // ref-counted: one attempt shared

    // Neither failed caller's handler lingers: after a successful retry only
    // the NEW subscriber receives frames.
    const unsubscribe = await subscriber.subscribe('licio:debate:d1', (message) =>
      received.push(`c:${message}`),
    );
    emit('licio:debate:d1', 'frame-1');
    expect(received).toEqual(['c:frame-1']);
    unsubscribe();
  });
});
