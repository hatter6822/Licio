// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signal processor (WS-C.4 orchestration). Ties the in-browser trackers together:
// engagement (visibility+focus) AND reading cadence gate active dwell, which is
// capped per item per session; source/context opens, return visits, and reply-depth
// traversal are recorded; and the bucketed §22.1 aggregate is assembled and
// buffered for upload. Collection only runs when personalization is enabled
// (privacy gate); raw events are processed here and never leave the browser.
import { SESSION_BUCKET_WINDOW_MS, sessionBucket } from '@licio/shared';
import { type AggregateInput, AggregateUploader, buildAggregate } from './aggregate.js';
import { CadenceTracker } from './cadence.js';
import { DEFAULT_DWELL_CAP_MS, DwellCapTracker } from './caps.js';
import { type Clock, DwellAccumulator } from './dwell.js';
import type { CollectionPolicy } from './privacy.js';
import { ReturnTracker, TraversalTracker } from './return-tracker.js';
import { OpenTracker } from './source-tracker.js';
import { EngagementTracker } from './visibility.js';

const COLLECTION_OFF: CollectionPolicy = {
  collect: false,
  privacyLevel: 'standard',
  identifier: 'privacy-bucket',
};

/** Default batched-upload cadence (WS-C.4.4: batched at intervals, not per-event). */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

/** Detach a timer from the event loop where supported (Node tests). */
function unref(handle: ReturnType<typeof setInterval>): void {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
}

export interface SignalProcessorOptions {
  uploader?: AggregateUploader;
  engagement?: EngagementTracker;
  cadence?: CadenceTracker;
  /** Return tracker (injected with localStorage persistence in production). */
  returnTracker?: ReturnTracker;
  capMs?: number;
  /** Monotonic clock for dwell (ms). */
  now?: Clock;
  /** Wall clock for session bucketing / returns / timestamps (epoch ms). */
  wallClock?: () => number;
  sessionWindowMs?: number;
  /** Tick cadence for the dwell/idle poll (ms, default 1s). */
  tickMs?: number;
  /** Batched-upload cadence (ms, default 30s). Configurable per WS-C.4.4. */
  flushIntervalMs?: number;
}

export class SignalProcessor {
  private readonly uploader: AggregateUploader;
  private readonly engagement: EngagementTracker;
  private readonly cadence: CadenceTracker;
  private readonly dwell: DwellAccumulator;
  private readonly cap: DwellCapTracker;
  private readonly opens = new OpenTracker();
  private readonly returns: ReturnTracker;
  private readonly traversal = new TraversalTracker();
  private readonly now: Clock;
  private readonly wallClock: () => number;
  private readonly sessionWindowMs: number;
  private readonly tickMs: number;
  private readonly flushIntervalMs: number;

  private policy: CollectionPolicy = COLLECTION_OFF;
  private currentItemId: string | null = null;
  private sessionBucketLabel: string;
  private lastDwellMs = 0;

  constructor(options: SignalProcessorOptions = {}) {
    this.uploader = options.uploader ?? new AggregateUploader();
    this.engagement = options.engagement ?? new EngagementTracker();
    this.cadence = options.cadence ?? new CadenceTracker();
    this.returns = options.returnTracker ?? new ReturnTracker();
    this.now =
      options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.sessionWindowMs = options.sessionWindowMs ?? SESSION_BUCKET_WINDOW_MS;
    this.tickMs = options.tickMs ?? 1_000;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.dwell = new DwellAccumulator(this.now);
    this.cap = new DwellCapTracker(options.capMs ?? DEFAULT_DWELL_CAP_MS);
    this.sessionBucketLabel = sessionBucket(this.wallClock(), this.sessionWindowMs);
  }

  /**
   * Set the collection policy. Turning collection off discards in-flight dwell,
   * the locally-persisted return history, AND any aggregate already buffered but
   * not yet uploaded — so opting out leaves no on-device signal state behind and
   * the interval/page-hide path can never upload a pre-opt-out capture after the
   * user opted out (WS-C.4.1d privacy gate).
   */
  setCollectionPolicy(policy: CollectionPolicy): void {
    this.policy = policy;
    if (!policy.collect) {
      this.dwell.setEngaged(false);
      this.dwell.reset();
      this.lastDwellMs = 0;
      this.returns.resetSession();
      this.uploader.clear();
    }
  }

  /**
   * The story currently in view. Switching away is the "done attending" boundary:
   * the outgoing item's final dwell is accrued and its §22.1 aggregate is snapshot
   * (so per-item attention is buffered on navigation, not only at session end), then
   * the new item — if any — records a (possibly returning) visit.
   */
  setActiveStory(storyId: string | null): void {
    if (storyId === this.currentItemId) return;
    this.captureCurrent();
    this.currentItemId = storyId;
    this.dwell.reset();
    this.lastDwellMs = 0;
    // Personalization gates the return tracker too (WS-C.4.1d): no visit is
    // recorded — or persisted — while collection is off.
    if (storyId && this.policy.collect) this.returns.visit(storyId, this.wallClock());
  }

  recordSourceOpen(openId: string, storyId: string): void {
    if (this.policy.collect) this.opens.open(openId, storyId, 'source', this.wallClock());
  }
  recordSourceClose(openId: string): void {
    this.opens.close(openId, this.wallClock());
  }
  recordContextOpen(openId: string, storyId: string): void {
    if (this.policy.collect) this.opens.open(openId, storyId, 'context', this.wallClock());
  }
  recordContextClose(openId: string): void {
    this.opens.close(openId, this.wallClock());
  }
  recordReplyDepth(storyId: string, depth: number): void {
    if (this.policy.collect) this.traversal.visitReplyDepth(storyId, depth);
  }
  markProgrammaticScroll(): void {
    this.cadence.markProgrammaticScroll();
  }

  private accrueDwell(): void {
    if (!this.currentItemId) return;
    const total = this.dwell.ms;
    const delta = total - this.lastDwellMs;
    this.lastDwellMs = total;
    if (delta > 0) this.cap.add(this.currentItemId, delta);
  }

  /** Whether an item accrued any attention this session (worth an aggregate). */
  private hasSignal(itemId: string): boolean {
    return (
      this.cap.get(itemId) > 0 ||
      this.opens.wasSourceOpened(itemId) ||
      this.opens.wasContextOpened(itemId) ||
      this.traversal.distinctReplyDepthLevels(itemId) > 0 ||
      this.returns.returnCount(itemId) > 0
    );
  }

  /**
   * Accrue the current item's pending dwell and, if it carries any signal, buffer
   * its aggregate. A no-op when there is no current item or collection is off, and
   * it never emits an empty (signal-free) aggregate. Re-captures across hide/switch
   * within a session are acceptable hints (dwell is monotonic; server-as-hint §6.11).
   */
  private captureCurrent(): void {
    if (!this.currentItemId) return;
    this.accrueDwell();
    if (this.policy.collect && this.hasSignal(this.currentItemId)) {
      this.captureAggregate(this.currentItemId);
    }
  }

  private maybeRolloverSession(wallNow: number): void {
    const next = sessionBucket(wallNow, this.sessionWindowMs);
    if (next === this.sessionBucketLabel) return;
    // Capture the closing session's aggregate before the caps/opens reset.
    this.captureCurrent();
    this.cap.resetSession();
    this.opens.resetSession();
    this.traversal.resetSession();
    this.dwell.reset();
    this.lastDwellMs = 0;
    this.sessionBucketLabel = next;
  }

  /** Advance dwell/idle accounting. Called on an interval by {@link start}. */
  tick(): void {
    const wallNow = this.wallClock();
    if (!this.policy.collect) {
      this.dwell.setEngaged(false);
      return;
    }
    this.maybeRolloverSession(wallNow);
    this.cadence.checkIdle(this.now());
    const engaged = this.engagement.isActive && this.cadence.cadence === 'reading';
    this.dwell.setEngaged(engaged);
    this.accrueDwell();
  }

  /** Whether an item has reached its dwell cap (for the Signal Ledger). */
  isCapReached(storyId: string): boolean {
    return this.cap.isCapped(storyId);
  }

  /** Assemble the bucketed aggregate for a story and buffer it for upload. */
  captureAggregate(storyId: string): void {
    if (!this.policy.collect) return;
    const input: AggregateInput = {
      storyId,
      identifier: this.policy.identifier,
      privacyLevel: this.policy.privacyLevel,
      sessionBucketLabel: this.sessionBucketLabel,
      cappedDwellMs: this.cap.get(storyId),
      sourceOpened: this.opens.wasSourceOpened(storyId),
      contextOpened: this.opens.wasContextOpened(storyId),
      distinctReplyDepthLevels: this.traversal.distinctReplyDepthLevels(storyId),
      returnCount: this.returns.returnCount(storyId),
      now: this.wallClock(),
    };
    this.uploader.add(buildAggregate(input));
  }

  /** Upload the buffered batch (best-effort; queues on failure). */
  flush(): Promise<void> {
    return this.uploader.flush();
  }

  /** Durable flush for page-hide: enqueue the batch so it survives a close. */
  async flushDurable(): Promise<void> {
    this.captureCurrent();
    await this.uploader.flushDurable();
  }

  /**
   * Wire DOM listeners, the dwell tick, the batched-upload interval, and the
   * page-hide durable flush. While the page is hidden the 1 Hz dwell tick is
   * paused (no active dwell accrues when not visible+focused anyway), and the
   * final batch is durably enqueued so it survives the page closing. Returns
   * teardown.
   */
  start(): () => void {
    const teardownEngagement = this.engagement.start();
    const teardownCadence = this.cadence.start();

    let tickInterval: ReturnType<typeof setInterval> | null = null;
    let flushInterval: ReturnType<typeof setInterval> | null = null;
    // Both the 1 Hz dwell tick and the batched-upload interval (WS-C.4.4) run only
    // while visible; both pause when hidden so there is no continuous background
    // work (WS-C.5.1 battery budget). The page-hide path durably flushes first.
    const startTimers = (): void => {
      if (tickInterval === null) {
        tickInterval = setInterval(() => this.tick(), this.tickMs);
        unref(tickInterval);
      }
      if (flushInterval === null) {
        flushInterval = setInterval(() => void this.flush(), this.flushIntervalMs);
        unref(flushInterval);
      }
    };
    const stopTimers = (): void => {
      if (tickInterval !== null) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
      if (flushInterval !== null) {
        clearInterval(flushInterval);
        flushInterval = null;
      }
    };
    startTimers();

    const onVisibility = (): void => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        void this.flushDurable();
        stopTimers();
      } else {
        startTimers();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      teardownEngagement();
      teardownCadence();
      stopTimers();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }
}
