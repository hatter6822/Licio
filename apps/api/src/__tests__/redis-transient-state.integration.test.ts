// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Redis integration tests for the multi-instance transient-state
// adapters this remediation pass added: the PHI session-sequence store
// (WS-H.6.1a), the WS-S §15.4 rendezvous signal mailbox, the WS-R.15.6a LCAP
// signaling mailbox, and the comment/debate pub/sub broadcasters (WS-T).  Each
// leg exercises the CROSS-INSTANCE property that motivated the adapter — two
// independent adapter instances over one Redis observe each other's writes.
// Runs ONLY when REDIS_URL is set (the docker-compose dev Redis; CI's service
// container).
//
//   REDIS_URL=redis://localhost:6379 pnpm test
import { randomUUID } from 'node:crypto';
import type { ContributionPublic, DebateArenaPublic } from '@licio/shared';
import IORedis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RedisCommentBroadcaster,
  RedisDebateBroadcaster,
  RefCountedSubscriber,
} from '../forum/redis-broadcasters.js';
import { RedisSessionTopicSequenceStore } from '../invariants/redis-session-store.js';
import { RedisLcapSignalMailbox } from '../lcap/redis-signal-mailbox.js';
import { RedisSignalMailbox } from '../private-rendezvous/redis-signal-mailbox.js';
import {
  MAX_SIGNALS_PER_PEER,
  MAX_SIGNALS_PER_SENDER,
  type StoredSignal,
} from '../private-rendezvous/stores.js';

const REDIS_URL = process.env['REDIS_URL'];

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe.skipIf(!REDIS_URL)('Redis transient-state adapters (live Redis)', () => {
  const url = REDIS_URL as string;
  const redis = new IORedis(url);
  const openedClients: IORedis[] = [redis];
  const open = (): IORedis => {
    const client = new IORedis(url);
    openedClients.push(client);
    return client;
  };

  afterAll(async () => {
    await Promise.all(openedClients.map((client) => client.quit().catch(() => {})));
  });

  describe('RedisSessionTopicSequenceStore (PHI, WS-H.6.1a)', () => {
    it('appends across instances into ONE shared, capped sequence', async () => {
      const prefix = `t:${randomUUID()}:`;
      const a = new RedisSessionTopicSequenceStore(open(), prefix);
      const b = new RedisSessionTopicSequenceStore(open(), prefix);
      const now = Date.now();
      // Alternating instances (a user's events landing on different pods).
      for (let i = 0; i < 6; i++) {
        const store = i % 2 === 0 ? a : b;
        await store.append('sess-1', { topicClusterId: `topic-${i}`, atMs: now + i }, now, 4);
      }
      const seq = await a.get('sess-1', now);
      expect(seq.map((t) => t.topicClusterId)).toEqual([
        'topic-2',
        'topic-3',
        'topic-4',
        'topic-5',
      ]);

      await b.append('sess-2', { topicClusterId: 'solo', atMs: now }, now, 4);
      const live = await a.listLive(now);
      expect(live.map((entry) => entry.sessionKey).sort()).toEqual(['sess-1', 'sess-2']);
      await a.clear();
      expect(await b.listLive(now)).toEqual([]);
    });
  });

  describe('RedisSignalMailbox (WS-S §15.4)', () => {
    const signal = (over: Partial<StoredSignal> = {}): StoredSignal => ({
      roomBlindId: 'room-blind',
      senderBlindId: 'sender-1',
      recipientBlindId: 'recipient-1',
      ciphertext: 'b64ciphertext',
      expiresAt: Date.now() + 60_000,
      ...over,
    });

    it('a signal posted on one instance drains on another — consumed in full, once', async () => {
      const prefix = `t:${randomUUID()}:`;
      const a = new RedisSignalMailbox(open(), prefix);
      const b = new RedisSignalMailbox(open(), prefix);
      const recipient = `rcpt-${randomUUID()}`;
      await a.putSignal(signal({ recipientBlindId: recipient, ciphertext: 'one' }));
      await a.putSignal(
        signal({ recipientBlindId: recipient, senderBlindId: 'sender-2', ciphertext: 'two' }),
      );
      const drained = await b.drainSignals(recipient, Date.now(), 8);
      expect(drained.map((s) => s.ciphertext).sort()).toEqual(['one', 'two']);
      expect(await a.drainSignals(recipient, Date.now(), 8)).toEqual([]); // consumed once
    });

    it('enforces the per-sender sub-cap (back-pressure) and drops expired signals', async () => {
      const prefix = `t:${randomUUID()}:`;
      const mailbox = new RedisSignalMailbox(open(), prefix);
      const recipient = `rcpt-${randomUUID()}`;
      for (let i = 0; i < MAX_SIGNALS_PER_SENDER + 5; i++) {
        await mailbox.putSignal(signal({ recipientBlindId: recipient, ciphertext: `c${i}` }));
      }
      // An expired signal never surfaces at drain.
      await mailbox.putSignal(
        signal({
          recipientBlindId: recipient,
          senderBlindId: 'sender-2',
          ciphertext: 'stale',
          expiresAt: Date.now() - 1,
        }),
      );
      const drained = await mailbox.drainSignals(recipient, Date.now(), 8);
      expect(drained).toHaveLength(MAX_SIGNALS_PER_SENDER); // the sub-cap held
      expect(drained.some((s) => s.ciphertext === 'stale')).toBe(false);
    });

    it('ALWAYS admits at the queue cap via a fair random eviction (never blocks)', async () => {
      const prefix = `t:${randomUUID()}:`;
      const mailbox = new RedisSignalMailbox(open(), prefix);
      const recipient = `rcpt-${randomUUID()}`;
      // A fragmented flood: a fresh sender id per signal, up to the queue cap.
      for (let i = 0; i < MAX_SIGNALS_PER_PEER; i++) {
        await mailbox.putSignal(
          signal({ recipientBlindId: recipient, senderBlindId: `flood-${i}`, ciphertext: `f${i}` }),
        );
      }
      // A fresh honest offer is still ADMITTED (random eviction, never a block).
      await mailbox.putSignal(
        signal({ recipientBlindId: recipient, senderBlindId: 'honest', ciphertext: 'offer' }),
      );
      const drained = await mailbox.drainSignals(recipient, Date.now(), 8);
      expect(drained).toHaveLength(MAX_SIGNALS_PER_PEER); // bounded — one was evicted
      expect(drained.some((s) => s.ciphertext === 'offer')).toBe(true);
    });
  });

  describe('RedisLcapSignalMailbox (WS-R.15.6a)', () => {
    const config = { maxBlobBytes: 64, maxQueuePerPeer: 3, ttlMs: 60_000, maxPeers: 2 };

    it('routes an opaque blob across instances, byte-faithful, drained once', async () => {
      const prefix = `t:${randomUUID()}:`;
      const a = new RedisLcapSignalMailbox(open(), config, prefix);
      const b = new RedisLcapSignalMailbox(open(), config, prefix);
      const blob = new Uint8Array([0, 1, 254, 255, 42]);
      expect(await a.post('peerB', blob, Date.now())).toEqual({ ok: true });
      const drained = await b.drain('peerB', Date.now());
      expect(drained).toEqual([blob]);
      expect(await a.drain('peerB', Date.now())).toEqual([]);
    });

    it('bounds the per-peer queue (drop-oldest) and the distinct-recipient registry', async () => {
      const prefix = `t:${randomUUID()}:`;
      const mailbox = new RedisLcapSignalMailbox(open(), config, prefix);
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await mailbox.post('peerQ', new Uint8Array([i]), now);
      }
      const drained = await mailbox.drain('peerQ', now);
      expect(drained).toHaveLength(3); // capped, oldest dropped
      expect(drained[0]).toEqual(new Uint8Array([2]));

      // Registry bound: a THIRD distinct recipient is refused (429) while the
      // first two mailboxes keep accepting.
      expect(await mailbox.post('peer1', new Uint8Array([1]), now)).toEqual({ ok: true });
      expect(await mailbox.post('peer2', new Uint8Array([2]), now)).toEqual({ ok: true });
      expect(await mailbox.post('peer3', new Uint8Array([3]), now)).toEqual({
        ok: false,
        status: 429,
      });
      expect(await mailbox.post('peer1', new Uint8Array([9]), now)).toEqual({ ok: true });

      // Validation parity with the in-memory adapter.
      expect(await mailbox.post('has space', new Uint8Array([1]), now)).toEqual({
        ok: false,
        status: 400,
      });
      expect(await mailbox.post('peer1', new Uint8Array(65), now)).toEqual({
        ok: false,
        status: 413,
      });
    });
  });

  describe('Redis comment/debate broadcasters (WS-T live fan-out)', () => {
    const publicContribution: ContributionPublic = {
      contribution_id: '00000000-0000-4000-8000-0000000000c1',
      thread_id: '00000000-0000-4000-8000-0000000000a1',
      type: 'comment',
      body: 'A live comment.',
      citations: [],
      metadata: {},
      target_claim_id: null,
      parent_contribution_id: null,
      author_handle: 'alice',
      author_display_name: 'Alice',
      is_author: false,
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-18T00:00:00.000Z',
      edited: false,
      depth: 0,
      child_count: 0,
      moderation_state: 'published',
      dispute_status: 'none',
      active_debate_id: null,
    };

    it('a comment published on instance A reaches a subscriber on instance B', async () => {
      const a = new RedisCommentBroadcaster(open(), new RefCountedSubscriber(open()));
      const b = new RedisCommentBroadcaster(open(), new RefCountedSubscriber(open()));
      const received: string[] = [];
      // subscribe resolves only after the Redis SUBSCRIBE ack — no sleep needed.
      const unsubscribe = await b.subscribe(publicContribution.thread_id, (frame) => {
        received.push(frame.eventId);
      });
      a.publish(publicContribution.thread_id, {
        eventId: publicContribution.contribution_id,
        contribution: publicContribution,
      });
      // A non-conforming frame is dropped on publish (fail closed).
      a.publish(publicContribution.thread_id, {
        eventId: 'x',
        contribution: { ...publicContribution, score: 99 } as never,
      });
      await waitFor(() => received.length > 0);
      unsubscribe();
      expect(received).toEqual([publicContribution.contribution_id]);
    });

    it('a debate frame crosses instances and a corrupted message never dispatches', async () => {
      const position = (side: 'incumbent' | 'challenger') => ({
        side,
        author_handle: 'u',
        author_display_name: 'U',
        is_author: false,
        summary: 'my case',
        citations: [],
        updated_at: '2026-07-05T00:00:00.000Z',
        submitted: true,
      });
      const publicDebate: DebateArenaPublic = {
        debate_id: '00000000-0000-4000-8000-0000000000f1',
        story_id: '00000000-0000-4000-8000-0000000000f2',
        thread_id: '00000000-0000-4000-8000-0000000000f3',
        room_id: null,
        target_type: 'comment',
        target_contribution_id: '00000000-0000-4000-8000-0000000000f4',
        challenger_contribution_id: '00000000-0000-4000-8000-0000000000f5',
        state: 'open',
        incumbent: position('incumbent'),
        challenger: position('challenger'),
        edit_deadline_at: '2026-07-05T12:00:00.000Z',
        verdict: null,
        winner: null,
        decided_by: null,
        rationale: null,
        confidence: null,
        ai_output_id: null,
        verdict_at: null,
        override_deadline_at: null,
        overridden_by_handle: null,
        override_reason: null,
        resolved_at: null,
        viewer_role: 'observer',
        created_at: '2026-07-05T00:00:00.000Z',
        updated_at: '2026-07-05T00:00:00.000Z',
      };
      const pubConnection = open();
      const a = new RedisDebateBroadcaster(pubConnection, new RefCountedSubscriber(open()));
      const b = new RedisDebateBroadcaster(open(), new RefCountedSubscriber(open()));
      const received: string[] = [];
      // subscribe resolves only after the Redis SUBSCRIBE ack — no sleep needed.
      const unsubscribe = await b.subscribe(publicDebate.debate_id, (frame) => {
        received.push(frame.arena.debate_id);
      });
      // A corrupted raw message on the channel is dropped by the fail-closed
      // delivery-side validation, never dispatched.
      await pubConnection.publish(`licio:debate:${publicDebate.debate_id}`, 'not-json');
      a.publish(publicDebate.debate_id, publicDebate);
      await waitFor(() => received.length > 0);
      unsubscribe();
      expect(received).toEqual([publicDebate.debate_id]);
    });
  });
});
