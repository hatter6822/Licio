// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level signal-processor singleton. The route pages drive it (setActiveStory,
// recordSourceOpen, recordReplyDepth…) and the app bootstrap starts it and
// applies the collection policy from the user's privacy settings. Kept as a lazy
// singleton so importing a page never constructs DOM listeners on its own. The
// production processor is wired with localStorage-backed return persistence so
// cross-session returns and rage-loops survive a reload (WS-C.4.3).
import { SignalProcessor } from './processor.js';
import { createReturnStore } from './return-store.js';
import { ReturnTracker } from './return-tracker.js';

let processor: SignalProcessor | null = null;

export function getSignalProcessor(): SignalProcessor {
  if (!processor) {
    processor = new SignalProcessor({
      returnTracker: new ReturnTracker({}, createReturnStore()),
    });
  }
  return processor;
}

/** Replace the singleton (tests). */
export function setSignalProcessor(next: SignalProcessor | null): void {
  processor = next;
}
