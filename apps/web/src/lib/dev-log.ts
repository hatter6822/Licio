// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dev-only diagnostics for otherwise-silently-swallowed failures.  A fail-closed `catch` (skip a
// tampered signal, drop a stale ICE candidate, tolerate a radio that won't start) is the right
// runtime behaviour, but swallowing the error SILENTLY hides real bugs.  `devWarn` surfaces it in
// development and is a no-op in production — and it deliberately logs only a message + the Error
// (never the signal/candidate/payload, which can carry IP or identity data).

const IS_DEV = import.meta.env.DEV === true;

/** Report an error that a fail-closed `catch` would otherwise swallow.  Dev-only; never logs
 *  payload data (only the message + the thrown Error). */
export function devWarn(message: string, error?: unknown): void {
  if (IS_DEV) console.warn(`[licio] ${message}`, error ?? '');
}
