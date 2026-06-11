// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Consumer router acceptance (WS-E.1.5 + WS-E.1.2): the pay-to-rank firewall,
// classification-based delivery, at-least-once + idempotency, dead-lettering,
// and the security assertion that no wallet/payment/treasury field is
// reachable from any scoring input path (SPEC §13.6 / §30.6).

import { randomUUID } from 'node:crypto';
import {
  ALL_EVENT_TOPICS,
  isKnomosisTopic,
  type LicioEvent,
  licioEventSchema,
} from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { type EventConsumer, EventRouter, RouterPolicyViolation } from '../events/router.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';
import { InMemoryConsumerCheckpointStore, InMemoryDeadLetterStore } from '../events/stores.js';
import { attentionEvent, sourceOpenEvent } from './ws-e-helpers.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const T0 = new Date().toISOString();

const KNOMOSIS_TOPIC_LIST = ALL_EVENT_TOPICS.filter((topic) => isKnomosisTopic(topic));

function contributionEvent(): LicioEvent {
  return licioEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'contribution.created',
    timestamp: T0,
    schema_version: '1',
    contribution_id: randomUUID(),
    thread_id: U1,
    user_id: U2,
    contribution_type: 'question',
    target_claim_id: null,
    parent_contribution_id: null,
    has_citation: false,
    accusation_flag: false,
    privacy_classification: 'public',
    retention_tier: 'public_contribution',
  });
}

function paymentIntentEvent(): LicioEvent {
  return licioEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'payment.intent.created',
    timestamp: T0,
    schema_version: '1',
    payment_intent_id: randomUUID(),
    user_id: U2,
    room_id: null,
    target_type: 'bounty',
    target_id: U1,
    asset: 'USDC',
    amount: '2500000',
    jurisdiction_state: 'allowed',
    privacy_classification: 'restricted',
    retention_tier: 'security_log',
  });
}

function treasuryDepositEvent(): LicioEvent {
  return licioEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'treasury.deposit.indexed',
    timestamp: T0,
    schema_version: '1',
    treasury_id: randomUUID(),
    room_id: U1,
    asset: 'ETH',
    amount: '1000000000000000000',
    tx_ref: 'd'.repeat(64),
    privacy_classification: 'restricted',
    retention_tier: 'security_log',
  });
}

function walletLinkedEvent(): LicioEvent {
  return licioEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'wallet.linked',
    timestamp: T0,
    schema_version: '1',
    user_id: U2,
    wallet_ref: 'a'.repeat(64),
    chain_id: 1,
    wallet_type: 'eoa',
    privacy_classification: 'restricted',
    retention_tier: 'account_active',
  });
}

function consumer(overrides: Partial<EventConsumer>): EventConsumer {
  return {
    name: 'test-consumer',
    topics: ['contribution.created'],
    accessClassifications: ['public'],
    scoring: false,
    handle: async () => {},
    ...overrides,
  };
}

let deadLetters: InMemoryDeadLetterStore;
let router: EventRouter;

beforeEach(() => {
  deadLetters = new InMemoryDeadLetterStore();
  router = new EventRouter({ deadLetters, maxAttempts: 3 });
});

describe('pay-to-rank firewall (WS-E.1.2 / WS-E.1.5)', () => {
  it('the registry flags exactly the 18 SPEC §21.3 Knomosis topics', () => {
    expect(KNOMOSIS_TOPIC_LIST).toHaveLength(18);
  });

  it('refuses to subscribe a scoring consumer to ANY Knomosis topic', () => {
    for (const topic of KNOMOSIS_TOPIC_LIST) {
      const r = new EventRouter({ deadLetters: new InMemoryDeadLetterStore() });
      expect(
        () =>
          r.register(
            consumer({
              scoring: true,
              topics: [topic],
              accessClassifications: ['public', 'aggregated'],
            }),
          ),
        `scoring consumer must never subscribe to ${topic}`,
      ).toThrow(RouterPolicyViolation);
    }
  });

  it('refuses a scoring consumer holding restricted or sensitive access', () => {
    expect(() =>
      router.register(consumer({ scoring: true, accessClassifications: ['public', 'restricted'] })),
    ).toThrow(/scoring reads public \+ aggregated only/);
    expect(() =>
      router.register(
        consumer({ name: 'c2', scoring: true, accessClassifications: ['sensitive'] }),
      ),
    ).toThrow(RouterPolicyViolation);
  });

  it('allows a non-scoring, restricted-authorized consumer to receive Knomosis topics', async () => {
    // The crypto flag must be ON for any Knomosis delivery at all (the
    // fail-closed default withholds it; events-recovery.test.ts covers that).
    router = new EventRouter({
      deadLetters,
      knomosisEnabled: () => true,
    });
    const received: string[] = [];
    router.register(
      consumer({
        name: 'compliance-intake',
        scoring: false,
        topics: ['payment.intent.created'],
        accessClassifications: ['restricted'],
        handle: async (event) => {
          received.push(event.event_type);
        },
      }),
    );
    await router.publish(paymentIntentEvent());
    expect(received).toEqual(['payment.intent.created']);
  });

  it('security: no wallet/payment/treasury field reaches a scoring consumer', async () => {
    // Register a scoring consumer on every topic it may legally hold, then
    // publish social AND financial events. The delivered payloads — the
    // complete scoring input surface — must carry no financial field.
    const delivered: LicioEvent[] = [];
    router.register(
      consumer({
        name: 'scoring',
        scoring: true,
        topics: ['attention.aggregate', 'source.opened.aggregate', 'contribution.created'],
        accessClassifications: ['public', 'aggregated'],
        handle: async (event) => {
          delivered.push(event);
        },
      }),
    );
    await router.publish(attentionEvent(U2) as LicioEvent);
    await router.publish(sourceOpenEvent(U2) as LicioEvent);
    await router.publish(contributionEvent());
    await router.publish(paymentIntentEvent());
    await router.publish(treasuryDepositEvent());
    await router.publish(walletLinkedEvent());
    expect(delivered).toHaveLength(3);
    const serialized = JSON.stringify(delivered).toLowerCase();
    for (const forbidden of ['wallet', 'payment', 'amount', 'treasury', 'asset', 'chain_id']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('classification-based delivery (WS-E.1.5)', () => {
  it('rejects a subscription lacking the topic classification', () => {
    expect(() =>
      router.register(
        consumer({ topics: ['moderation.case.created'], accessClassifications: ['public'] }),
      ),
    ).toThrow(/lacks the "restricted" access/);
  });

  it('rejects unregistered topics at subscription time', () => {
    expect(() => router.register(consumer({ topics: ['attention.raw' as never] }))).toThrow(
      /unregistered topic/,
    );
  });
});

describe('delivery semantics (WS-E.1.5)', () => {
  it('delivers to every subscribed consumer and tracks lag metrics', async () => {
    const seen: string[] = [];
    router.register(
      consumer({
        name: 'a',
        handle: async (e) => {
          seen.push(`a:${e.event_id}`);
        },
      }),
    );
    router.register(
      consumer({
        name: 'b',
        handle: async (e) => {
          seen.push(`b:${e.event_id}`);
        },
      }),
    );
    const event = contributionEvent();
    await router.publish(event);
    expect(seen).toHaveLength(2);
    const metrics = router.metrics().get('a');
    expect(metrics?.delivered).toBe(1);
    expect(metrics?.lastDeliveredEventAt).toBe(event.timestamp);
  });

  it('idempotent re-delivery does not double-count (event_id dedup)', async () => {
    let handled = 0;
    router.register(
      consumer({
        handle: async () => {
          handled += 1;
        },
      }),
    );
    const event = contributionEvent();
    await router.publish(event);
    await router.publish(event);
    expect(handled).toBe(1);
    expect(router.metrics().get('test-consumer')?.duplicatesSkipped).toBe(1);
  });

  it('retries a failing consumer then dead-letters the poisoned event', async () => {
    let attempts = 0;
    router.register(
      consumer({
        name: 'poisoned',
        handle: async () => {
          attempts += 1;
          throw new Error('cannot process');
        },
      }),
    );
    const event = contributionEvent();
    await router.publish(event);
    expect(attempts).toBe(3); // maxAttempts, then DLQ — never an infinite loop
    const letters = await deadLetters.list('poisoned');
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      eventId: event.event_id,
      topic: 'contribution.created',
      attempts: 3,
      error: 'cannot process',
    });
    // The dead-lettered event is not retried on re-publish (seen-set).
    await router.publish(event);
    expect(attempts).toBe(3);
  });

  it('a failing consumer never blocks delivery to healthy consumers', async () => {
    const healthy: string[] = [];
    router.register(
      consumer({
        name: 'failing',
        handle: async () => {
          throw new Error('down');
        },
      }),
    );
    router.register(
      consumer({
        name: 'healthy',
        handle: async (e) => {
          healthy.push(e.event_id);
        },
      }),
    );
    await router.publish(contributionEvent());
    expect(healthy).toHaveLength(1);
  });

  it('rejects duplicate consumer names', () => {
    router.register(consumer({}));
    expect(() => router.register(consumer({}))).toThrow(/already registered/);
  });
});

describe('store swapping through the service container (production wiring)', () => {
  it('honors dead-letter + checkpoint stores swapped in AFTER router construction', async () => {
    // Production boot builds the in-memory container first and assigns the
    // Drizzle adapters afterwards (index.ts). The router must read its stores
    // lazily — otherwise checkpoints/dead letters keep landing in the replaced
    // in-memory stores while recovery and the admin surface read the durable ones.
    const services = createInMemoryEventPipelineServices();
    services.router.register({
      name: 'durable-flaky',
      topics: ['contribution.created'],
      accessClassifications: ['public'],
      scoring: false,
      durable: true,
      handle: async (event) => {
        if (event.event_id.startsWith('a')) throw new Error('poisoned');
      },
    });
    // Swap-by-assignment, exactly like the production Drizzle wiring.
    const swappedDeadLetters = new InMemoryDeadLetterStore();
    const swappedCheckpoints = new InMemoryConsumerCheckpointStore();
    services.deadLetters = swappedDeadLetters;
    services.checkpoints = swappedCheckpoints;

    // The poison trigger is "id starts with 'a'" — force the OK event's id
    // to start with 'b' (a random hex UUID starts with 'a' 1/16 of the time,
    // which made this test flaky).
    const ok = { ...contributionEvent(), event_id: `b${randomUUID().slice(1)}` } as LicioEvent;
    await services.router.publish(ok);
    expect(await swappedCheckpoints.get('durable-flaky')).toBe(ok.timestamp);

    const poisoned = { ...contributionEvent(), event_id: `a${randomUUID().slice(1)}` };
    await services.router.publish(poisoned as LicioEvent);
    expect(await swappedDeadLetters.list('durable-flaky')).toHaveLength(1);
  });

  it('honors a crypto-flag provider swapped in after construction (fail-closed until then)', async () => {
    const services = createInMemoryEventPipelineServices();
    const received: string[] = [];
    services.router.register({
      name: 'wallet-indexer',
      topics: ['wallet.linked'],
      accessClassifications: ['restricted'],
      scoring: false,
      handle: async (event) => {
        received.push(event.event_type);
      },
    });
    await services.router.publish(walletLinkedEvent());
    expect(received).toEqual([]); // fail-closed default
    services.cryptoFlagEnabled = () => true; // ops flips the flag provider
    await services.router.publish(walletLinkedEvent());
    expect(received).toEqual(['wallet.linked']);
  });
});
