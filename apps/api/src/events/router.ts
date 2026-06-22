// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Event publisher + consumer router (WS-E.1.5, SPEC §21.3/§21.5). Events are
// stored durably FIRST (the PostgreSQL event store is the log of record;
// replay-by-topic recovers a crashed consumer), then routed in-process to
// named consumers. THREE invariants are enforced at BOTH subscription and
// delivery time (defense in depth — a flag is never trusted from one check):
//
//   1. THE PAY-TO-RANK FIREWALL — a Knomosis topic can never be delivered to a
//      scoring (PWAtt/ranking) consumer, and a scoring consumer may hold only
//      `public` + `aggregated` access (so `restricted` reporter/wallet data is
//      structurally out of reach of any scoring input path, SPEC §13.6/§30.6).
//   2. CLASSIFICATION-BASED DELIVERY — a topic is deliverable only to
//      consumers holding its privacy classification.
//   3. THE CRYPTO FEATURE FLAG (WS-E.1.2 / SPEC §17.1) — while the flag is off
//      (the fail-closed default), Knomosis topics are not delivered to ANY
//      consumer, however authorized.
//
// Delivery is at-least-once with consumer-side idempotency: the router skips
// event_ids it has already delivered to a consumer (bounded LRU), and DURABLE
// consumers checkpoint the newest delivered event time so `replayConsumer`
// (events/recovery.ts) can re-drive them from the durable log after a crash.
// Repeatedly failing events dead-letter after `maxAttempts` instead of
// looping; `redrive` retries a dead letter once after the cause is fixed.
// Per-consumer lag/health metrics are exposed for observability — no attention
// values appear in any metric label.
import {
  type EventTopic,
  isKnomosisTopic,
  isRegisteredTopic,
  type LicioEvent,
  type PrivacyClassification,
  TOPIC_REGISTRY,
} from '@licio/shared';
import type { ConsumerCheckpointStore, DeadLetterStore } from './stores.js';

export interface EventConsumer {
  name: string;
  topics: readonly EventTopic[];
  /** The privacy classifications this consumer is authorized to receive. */
  accessClassifications: readonly PrivacyClassification[];
  /** True for PWAtt/ranking consumers — the firewall subjects (WS-E.1.2). */
  scoring: boolean;
  /**
   * True ⇒ the router persists a per-consumer checkpoint (the newest delivered
   * event timestamp) so startup recovery can replay missed events from the
   * durable log. Consumers whose state is rebuildable (e.g. the real-time
   * counters) stay non-durable and recover by rebuild instead.
   */
  durable?: boolean;
  handle(event: LicioEvent): Promise<void>;
}

export class RouterPolicyViolation extends Error {}

export interface ConsumerMetrics {
  delivered: number;
  duplicatesSkipped: number;
  failed: number;
  deadLettered: number;
  /** Knomosis events withheld because the crypto flag is off (observability). */
  withheldByCryptoFlag: number;
  /** WS-Q.1.7c — events withheld because their (per-event) classification is
   *  outside this consumer's access (e.g. a room_only `restricted` content
   *  event reaching a public-only consumer). */
  withheldByClassification: number;
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

/**
 * A store given directly or as a provider closure. The service container
 * swaps production adapters in by ASSIGNMENT after construction (index.ts),
 * so the router must read its stores lazily — capturing an instance at
 * construction would silently keep writing checkpoints/dead letters to the
 * replaced in-memory store while recovery and the admin surface read the
 * durable one.
 */
type StoreOrProvider<T> = T | (() => T);

function asProvider<T extends object>(value: StoreOrProvider<T>): () => T {
  // Stores are method objects, never callable — `typeof` discriminates safely.
  return typeof value === 'function' ? (value as () => T) : () => value;
}

export class EventRouter {
  readonly #consumers = new Map<string, EventConsumer>();
  readonly #metrics = new Map<string, ConsumerMetrics>();
  /** Per-consumer recently-delivered event ids (bounded idempotency LRU). */
  readonly #seen = new Map<string, Set<string>>();
  readonly #deadLetters: () => DeadLetterStore;
  readonly #checkpoints: (() => ConsumerCheckpointStore) | null;
  readonly #knomosisEnabled: () => boolean;
  readonly #maxAttempts: number;
  readonly #seenCapacity: number;
  readonly #onError: (consumer: string, eventId: string, error: unknown) => void;
  /**
   * WS-S.1.4 — an OPTIONAL late-bound predicate (`true` ⇒ the room is a Private
   * P2P room).  When set, an event whose payload references a p2p room is
   * REFUSED at publish (never delivered to any consumer) and counted, because a
   * P2P room must emit NO server content event (PRIVATE_SPEC §8.4/§23.7).  This
   * is defense in depth: the submission/contribution guards already prevent
   * such events from being created, so a trip here means a bug.  Decoupled by
   * default (null ⇒ no-op), wired by the forum boot where the room store exists.
   */
  #p2pRoomGuard: ((roomId: string) => Promise<boolean>) | null = null;
  #p2pRoomEventsRejected = 0;

  constructor(options: {
    deadLetters: StoreOrProvider<DeadLetterStore>;
    /** Enables durable-consumer checkpointing + startup replay. */
    checkpoints?: StoreOrProvider<ConsumerCheckpointStore>;
    /** The crypto feature flag (SPEC §17.1); fail-closed false when absent. */
    knomosisEnabled?: () => boolean;
    maxAttempts?: number;
    seenCapacity?: number;
    onError?: (consumer: string, eventId: string, error: unknown) => void;
  }) {
    this.#deadLetters = asProvider(options.deadLetters);
    this.#checkpoints = options.checkpoints ? asProvider(options.checkpoints) : null;
    this.#knomosisEnabled = options.knomosisEnabled ?? (() => false);
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
      withheldByCryptoFlag: 0,
      withheldByClassification: 0,
      lastDeliveredEventAt: null,
    });
  }

  /**
   * WS-S.1.4 — wire the Private-P2P-room guard (the forum boot supplies it once
   * the room store exists; mirrors the search room-visibility late binding).
   */
  setP2pRoomGuard(guard: (roomId: string) => Promise<boolean>): void {
    this.#p2pRoomGuard = guard;
  }

  /** Count of events refused at publish for referencing a p2p room (§23.7). */
  get p2pRoomEventsRejected(): number {
    return this.#p2pRoomEventsRejected;
  }

  /** Deliver a validated event to every subscribed, authorized consumer. */
  async publish(event: LicioEvent): Promise<void> {
    // WS-S.1.4 — a P2P room emits NO server content event (§8.4): if the event
    // references a p2p room, refuse to deliver it to ANY consumer + count it.
    if (this.#p2pRoomGuard !== null) {
      const roomId = 'room_id' in event && typeof event.room_id === 'string' ? event.room_id : null;
      if (roomId !== null && (await this.#p2pRoomGuard(roomId))) {
        this.#p2pRoomEventsRejected += 1;
        this.#onError(
          '__router__',
          event.event_id,
          new RouterPolicyViolation(`event ${event.event_type} references a Private P2P room`),
        );
        return;
      }
    }
    for (const consumer of this.#consumers.values()) {
      if (!consumer.topics.includes(event.event_type)) continue;
      // Delivery-time re-check (defense in depth; never trust registration
      // alone — a registry change between boot and now must still hold).
      assertDeliverable(consumer, event.event_type);
      // WS-Q.1.7c — PER-EVENT classification routing: an event may be MORE
      // restrictive than its topic's base (a room_only content event is
      // `restricted`, not the topic's `public`). A consumer that does not hold
      // the event's actual classification is silently withheld, so an in-room
      // story's URL/topics/submitter never flow to a public/scoring consumer.
      if (!consumer.accessClassifications.includes(event.privacy_classification)) {
        const metrics = this.#metrics.get(consumer.name);
        if (metrics) metrics.withheldByClassification += 1;
        continue;
      }
      // Crypto-flag gate (WS-E.1.2): with the fail-closed flag off, Knomosis
      // events are withheld from EVERY consumer, however authorized.
      if (isKnomosisTopic(event.event_type) && !this.#knomosisEnabled()) {
        const metrics = this.#metrics.get(consumer.name);
        if (metrics) metrics.withheldByCryptoFlag += 1;
        continue;
      }
      await this.#deliver(consumer, event);
    }
  }

  /**
   * Re-deliver durable-log events to ONE named consumer (startup recovery,
   * events/recovery.ts). The normal policy guards and idempotency apply; the
   * consumer's checkpoint advances as usual.
   */
  async replayConsumer(consumerName: string, events: readonly LicioEvent[]): Promise<number> {
    const consumer = this.#consumers.get(consumerName);
    if (!consumer) throw new RouterPolicyViolation(`unknown consumer "${consumerName}"`);
    let delivered = 0;
    for (const event of events) {
      if (!consumer.topics.includes(event.event_type)) continue;
      assertDeliverable(consumer, event.event_type);
      // WS-Q.1.7c per-event classification gate (mirrors publish()).
      if (!consumer.accessClassifications.includes(event.privacy_classification)) continue;
      if (isKnomosisTopic(event.event_type) && !this.#knomosisEnabled()) continue;
      const before = this.#metrics.get(consumerName)?.delivered ?? 0;
      await this.#deliver(consumer, event);
      if ((this.#metrics.get(consumerName)?.delivered ?? 0) > before) delivered += 1;
    }
    return delivered;
  }

  /**
   * Retry ONE dead-lettered event after its cause has been fixed: clears the
   * consumer's seen-mark, attempts a single delivery cycle, and removes the
   * dead letter on success. Returns whether the re-drive succeeded.
   */
  async redrive(consumerName: string, event: LicioEvent): Promise<boolean> {
    const consumer = this.#consumers.get(consumerName);
    if (!consumer) throw new RouterPolicyViolation(`unknown consumer "${consumerName}"`);
    assertDeliverable(consumer, event.event_type);
    // WS-Q.1.7c per-event classification gate (mirrors publish()).
    if (!consumer.accessClassifications.includes(event.privacy_classification)) return false;
    if (isKnomosisTopic(event.event_type) && !this.#knomosisEnabled()) return false;
    this.#seen.get(consumerName)?.delete(event.event_id);
    const before = this.#metrics.get(consumerName)?.deadLettered ?? 0;
    await this.#deliver(consumer, event);
    const after = this.#metrics.get(consumerName)?.deadLettered ?? 0;
    if (after > before) return false; // dead-lettered again (still poisoned)
    await this.#deadLetters().delete(consumerName, event.event_id);
    return true;
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
        await this.#advanceCheckpoint(consumer, event.timestamp);
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
    await this.#deadLetters().append({
      consumerName: consumer.name,
      eventId: event.event_id,
      topic: event.event_type,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      attempts: this.#maxAttempts,
      failedAt: new Date().toISOString(),
    });
  }

  /** Persist the newest delivered event time for durable consumers. */
  async #advanceCheckpoint(consumer: EventConsumer, eventTimestamp: string): Promise<void> {
    if (!consumer.durable || !this.#checkpoints) return;
    const checkpoints = this.#checkpoints();
    const current = await checkpoints.get(consumer.name);
    if (current === null || Date.parse(eventTimestamp) > Date.parse(current)) {
      await checkpoints.set(consumer.name, eventTimestamp);
    }
  }

  metrics(): ReadonlyMap<string, ConsumerMetrics> {
    return this.#metrics;
  }

  /** Registered consumer names (diagnostics). */
  consumerNames(): string[] {
    return [...this.#consumers.keys()];
  }

  /** Registered consumers (read-only; used by startup recovery). */
  consumers(): readonly EventConsumer[] {
    return [...this.#consumers.values()];
  }
}
