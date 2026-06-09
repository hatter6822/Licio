// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Worker for readability extraction (WS-B.2.7). Runs the DOM-free
// `extractReadable` off the main thread on already-sanitized HTML, so parsing a
// large source never blocks the UI. The reader falls back to running the same
// pure function on the main thread where Workers are unavailable.
/// <reference lib="webworker" />
import { extractReadable } from './readability.js';

self.addEventListener('message', (event: MessageEvent<string>) => {
  (self as DedicatedWorkerGlobalScope).postMessage(extractReadable(event.data));
});
