// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level signal-processor singleton. The route pages drive it (setActiveStory,
// recordSourceOpen, recordBranchVisit…) and the app bootstrap starts it and
// applies the collection policy from the user's privacy settings. Kept as a lazy
// singleton so importing a page never constructs DOM listeners on its own.
import { SignalProcessor } from './processor.js';

let processor: SignalProcessor | null = null;

export function getSignalProcessor(): SignalProcessor {
  if (!processor) processor = new SignalProcessor();
  return processor;
}

/** Replace the singleton (tests). */
export function setSignalProcessor(next: SignalProcessor | null): void {
  processor = next;
}
