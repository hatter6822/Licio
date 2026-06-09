// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Worker for readability extraction (WS-B.2.7). Runs the DOM-free
// `extractReadable` off the main thread on already-sanitized HTML, so parsing a
// large source never blocks the UI. The reader falls back to running the same
// pure function on the main thread where Workers are unavailable.
/// <reference lib="webworker" />
import { extractReadable } from './readability.js';

self.addEventListener('message', (event: MessageEvent<string>) => {
  // A dedicated worker only receives messages from its same-origin owner document
  // (cross-origin pages cannot postMessage to another origin's worker), but verify
  // the origin explicitly anyway — `event.origin` is empty for in-process worker
  // messages, so this rejects only an unexpected cross-origin sender. The payload
  // is then validated to be the expected string before use.
  if (event.origin && event.origin !== self.location.origin) return;
  if (typeof event.data !== 'string') return;
  (self as DedicatedWorkerGlobalScope).postMessage(extractReadable(event.data));
});
