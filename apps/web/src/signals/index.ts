// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-browser signal processing (WS-C.4). Raw scroll/visibility/focus events are
// processed locally and discarded; only the bucketed §22.1 AttentionAggregate is
// ever uploaded (the no-raw-egress guarantee).
export { type AggregateInput, AggregateUploader, buildAggregate } from './aggregate.js';
export { type Cadence, CadenceTracker } from './cadence.js';
export { DEFAULT_DWELL_CAP_MS, DwellCapTracker } from './caps.js';
export { type Clock, DwellAccumulator } from './dwell.js';
export {
  assertNoRawEgress,
  type CollectionPolicy,
  PRIVACY_BUCKET,
  resolveCollectionPolicy,
  resolveIdentifier,
} from './privacy.js';
export { SignalProcessor, type SignalProcessorOptions } from './processor.js';
export { createReturnStore } from './return-store.js';
export {
  type ReturnSnapshot,
  ReturnTracker,
  type ReturnTrackerStore,
  TraversalTracker,
} from './return-tracker.js';
export { type OpenKind, OpenTracker } from './source-tracker.js';
export { EngagementTracker, type VisibilityReaders } from './visibility.js';
