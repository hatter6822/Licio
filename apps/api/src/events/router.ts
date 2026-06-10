// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Event publisher + consumer router (WS-E.1.5, SPEC §21.3/§21.5). Events are
// stored durably FIRST (the PostgreSQL event store is the log of record;
// replay-by-topic recovers a crashed consumer), then routed in-process to
// named consumers. Two invariants are enforced at BOTH subscription and
// delivery time (defense in depth — the flag is never trusted from one check):
//
//   1. THE PAY-TO-RANK FIREWALL — a Knomosis topic can never be delivered to a
//      scoring (PWAtt/ranking) consumer, and a scoring consumer may hold only
//      `public` + `aggregated` access (so `restricted` reporter/wallet data is
//      structurally out of reach of any scoring input path, SPEC §13.6/§30.6).
//   2. CLASSIFICATION-BASED DELIVERY — a topic is deliverable only to
//      consumers holding its privacy classification.
//
// Delivery is at-least-once with consumer-side idempotency: the router skips
// event_ids it has already delivered to a consumer (bounded LRU), and durable
// consumers checkpoint via ConsumerCheckpointStore. Repeatedly failing events
// dead-letter after `maxAttempts` instead of looping. Per-consumer lag/health
// metrics are exposed for observability — no attention values appear in any
// metric label.
import {
  type EventTopic,
  isKnomosisTopic,
  isRegisteredTopic,
  type LicioEvent,
  type PrivacyClassification,
  TOPIC_REGISTRY,
} from '@licio/shared';
import type { DeadLetterStore } from './stores.js';

export interface EventConsumer {
  name: string;
  topics: readonly EventTopic[];
  /** The privacy classifications this consumer is authorized to receive. */
  accessClassifications: readonly PrivacyClassification[];
  /** True for PWAtt/ranking consumers — the firewall subjects (WS-E.1.2). */
  scoring: boolean;
  handle(event: LicioEvent): Promise<void>;
}

export class RouterPolicyViolation extends Error {}

export interface ConsumerMetrics {
  delivered: number;
  duplicatesSkipped: number;
  failed: number;
  deadLettered: number;
  /** ISO timestamp of the newest event delivered (lag observability). */
  lastDeliveredEventAt: string | null;
}

const SCORING_ALLOWED_CLASSIFICATIONS: ReadonlySet<PrivacyClassification> = new Set([
  'public',
  'aggregated',
]);

/** Validate one consumer/topic pairing; throws on a policy violation. */
function assertDeliverable(consumer: EventConsumer, topic: string): void {
  if (!isRegisteredTopic(topic)) {
    throw new RouterPolicyViolation(`unregistered topic "${topic}"`);
  }
  if (consumer.scoring && isKnomosisTopic(topic)) {
    throw new RouterPolicyViolation(
      `pay-to-rank firewall: Knomosis topic "${topic}" can never reach scoring consumer "${consumer.name}"`,
    );
  }
  const classification = TOPIC_REGISTRY[topic].privacy_classification;
  if (!consumer.accessClassifications.includes(classification)) {
    throw new RouterPolicyViolation(
      `consumer "${consumer.name}" lacks the "${classification}" access required by "${topic}"`,
    );
  }
}

export class EventRouter {
  readonly #consumers = new Map<string, EventConsumer>();
  readonly #metrics = new Map<string, ConsumerMetrics>();
  /** Per-consumer recently-delivered event ids (bounded idempotency LRU). */
  readonly #seen = new Map<string, Set<string>>();
  readonly #deadLetters: DeadLetterStore;
  readonly #maxAttempts: number;
  readonly #seenCapacity: number;
  readonly #onError: (consumer: string, eventId: string, error: unknown) => void;

  constructor(options: {
    deadLetters: DeadLetterStore;
    maxAttempts?: number;
    seenCapacity?: number;
    onError?: (consumer: string, eventId: string, error: unknown) => void;
  }) {
    this.#deadLetters = options.deadLetters;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#seenCapacity = options.seenCapacity ?? 10_000;
    this.#onError = options.onError ?? (() => {});
  }

  /**
   * Register a named consumer. Subscription-time enforcement of the firewall
   * and classification rules (WS-E.1.5 acceptance: rejection is structural,
   * before any event flows).
   */
  register(consumer: EventConsumer): void {
    if (this.#consumers.has(consumer.name)) {
      throw new RouterPolicyViolation(`consumer "${consumer.name}" is already registered`);
    }
    if (consumer.scoring) {
      for (const classification of consumer.accessClassifications) {
        if (!SCORING_ALLOWED_CLASSIFICATIONS.has(classification)) {
          throw new RouterPolicyViolation(
            `scoring consumer "${consumer.name}" may not hold "${classification}" access ` +
              '(scoring reads public + aggregated only)',
          );
        }
      }
    }
    for (const topic of consumer.topics) {
      assertDeliverable(consumer, topic);
    }
    this.#consumers.set(consumer.name, consumer);
    this.#metrics.set(consumer.name, {
      delivered: 0,
      duplicatesSkipped: 0,
      failed: 0,
      deadLettered: 0,
      lastDeliveredEventAt: null,
    });
  }

  /** Deliver a validated event to every subscribed, authorized consumer. */
  async publish(event: LicioEvent): Promise<void> {
    for (const consumer of this.#consumers.values()) {
      if (!consumer.topics.includes(event.event_type)) continue;
      // Delivery-time re-check (defense in depth; never trust registration
      // alone — a registry change between boot and now must still hold).
      assertDeliverable(consumer, event.event_type);
      await this.#deliver(consumer, event);
    }
  }

  async #deliver(consumer: EventConsumer, event: LicioEvent): Promise<void> {
    const metrics = this.#metrics.get(consumer.name);
    if (!metrics) return;
    const seen = this.#seen.get(consumer.name) ?? new Set<string>();
    this.#seen.set(consumer.name, seen);
    if (seen.has(event.event_id)) {
      metrics.duplicatesSkipped += 1;
      return;
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        await consumer.handle(event);
        metrics.delivered += 1;
        metrics.lastDeliveredEventAt = event.timestamp;
        seen.add(event.event_id);
        if (seen.size > this.#seenCapacity) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        return;
      } catch (error) {
        lastError = error;
        metrics.failed += 1;
        this.#onError(consumer.name, event.event_id, error);
      }
    }
    // Poisoned event: dead-letter instead of looping (WS-E.1.5 acceptance).
    metrics.deadLettered += 1;
    seen.add(event.event_id);
    await this.#deadLetters.append({
      consumerName: consumer.name,
      eventId: event.event_id,
      topic: event.event_type,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      attempts: this.#maxAttempts,
      failedAt: new Date().toISOString(),
    });
  }

  metrics(): ReadonlyMap<string, ConsumerMetrics> {
    return this.#metrics;
  }

  /** Registered consumer names (diagnostics). */
  consumerNames(): string[] {
    return [...this.#consumers.keys()];
  }
}
