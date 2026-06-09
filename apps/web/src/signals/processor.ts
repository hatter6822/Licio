// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signal processor (WS-C.4 orchestration). Ties the in-browser trackers together:
// engagement (visibility+focus) AND reading cadence gate active dwell, which is
// capped per item per session; source/context opens, return visits, and branch
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

export interface SignalProcessorOptions {
  uploader?: AggregateUploader;
  engagement?: EngagementTracker;
  cadence?: CadenceTracker;
  capMs?: number;
  /** Monotonic clock for dwell (ms). */
  now?: Clock;
  /** Wall clock for session bucketing / returns / timestamps (epoch ms). */
  wallClock?: () => number;
  sessionWindowMs?: number;
  /** Tick cadence for the dwell/idle poll (ms, default 1s). */
  tickMs?: number;
}

export class SignalProcessor {
  private readonly uploader: AggregateUploader;
  private readonly engagement: EngagementTracker;
  private readonly cadence: CadenceTracker;
  private readonly dwell: DwellAccumulator;
  private readonly cap: DwellCapTracker;
  private readonly opens = new OpenTracker();
  private readonly returns = new ReturnTracker();
  private readonly traversal = new TraversalTracker();
  private readonly now: Clock;
  private readonly wallClock: () => number;
  private readonly sessionWindowMs: number;
  private readonly tickMs: number;

  private policy: CollectionPolicy = COLLECTION_OFF;
  private currentItemId: string | null = null;
  private sessionBucketLabel: string;
  private lastDwellMs = 0;

  constructor(options: SignalProcessorOptions = {}) {
    this.uploader = options.uploader ?? new AggregateUploader();
    this.engagement = options.engagement ?? new EngagementTracker();
    this.cadence = options.cadence ?? new CadenceTracker();
    this.now =
      options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.sessionWindowMs = options.sessionWindowMs ?? SESSION_BUCKET_WINDOW_MS;
    this.tickMs = options.tickMs ?? 1_000;
    this.dwell = new DwellAccumulator(this.now);
    this.cap = new DwellCapTracker(options.capMs ?? DEFAULT_DWELL_CAP_MS);
    this.sessionBucketLabel = sessionBucket(this.wallClock(), this.sessionWindowMs);
  }

  /** Set the collection policy. Turning collection off discards in-flight dwell. */
  setCollectionPolicy(policy: CollectionPolicy): void {
    this.policy = policy;
    if (!policy.collect) {
      this.dwell.setEngaged(false);
      this.dwell.reset();
      this.lastDwellMs = 0;
    }
  }

  /** The story currently in view. Switching captures the previous item's dwell. */
  setActiveStory(storyId: string | null): void {
    if (storyId === this.currentItemId) return;
    this.accrueDwell();
    this.currentItemId = storyId;
    this.dwell.reset();
    this.lastDwellMs = 0;
    if (storyId) this.returns.visit(storyId, this.wallClock());
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
  recordBranchVisit(storyId: string, branchId: string): void {
    if (this.policy.collect) this.traversal.visitBranch(storyId, branchId);
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

  private maybeRolloverSession(wallNow: number): void {
    const next = sessionBucket(wallNow, this.sessionWindowMs);
    if (next === this.sessionBucketLabel) return;
    // Capture the closing session's aggregate before the caps/opens reset.
    if (this.currentItemId) {
      this.accrueDwell();
      this.captureAggregate(this.currentItemId);
    }
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
      distinctBranches: this.traversal.distinctBranches(storyId),
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
    if (this.currentItemId && this.policy.collect) {
      this.accrueDwell();
      this.captureAggregate(this.currentItemId);
    }
    await this.uploader.flushDurable();
  }

  /** Wire DOM listeners + the tick interval + page-hide durable flush. */
  start(): () => void {
    const teardownEngagement = this.engagement.start();
    const teardownCadence = this.cadence.start();
    const interval = setInterval(() => this.tick(), this.tickMs);
    if (typeof interval === 'object' && 'unref' in interval) {
      (interval as { unref: () => void }).unref();
    }
    const onHide = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        void this.flushDurable();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onHide);
    }
    return () => {
      teardownEngagement();
      teardownCadence();
      clearInterval(interval);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onHide);
      }
    };
  }
}
