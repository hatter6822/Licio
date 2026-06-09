// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Privacy-safe client telemetry / RUM (WS-C observability notes). Events are
// buffered and delivered to the BFF ingest endpoint via `sendBeacon` (or a
// keepalive fetch fallback), validated against the shared schema before send so
// nothing outside the PII-free shape can egress. Callers must pass coarse,
// non-identifying labels (route PATTERNS, not paths; error codes, not messages).
import { type TelemetryEvent, telemetryBatchSchema } from '@licio/shared';

const API_BASE: string =
  (import.meta.env['VITE_API_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';
const ENDPOINT = `${API_BASE}/v1/telemetry`;
const FLUSH_DELAY_MS = 5_000;
const MAX_BUFFER = 50;

export type TelemetrySink = (events: TelemetryEvent[]) => void;
export type TelemetryInput = Omit<TelemetryEvent, 'at'>;

let buffer: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sink: TelemetrySink | null = null;

function defaultSink(events: TelemetryEvent[]): void {
  let body: string;
  try {
    // Re-validate before send: a malformed/oversized batch is dropped, never sent.
    body = JSON.stringify(telemetryBatchSchema.parse({ events }));
  } catch {
    return;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    return;
  }
  if (typeof fetch === 'function') {
    void fetch(ENDPOINT, {
      method: 'POST',
      body,
      keepalive: true,
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    }).catch(() => undefined);
  }
}

/** Override the delivery sink (tests). Pass null to restore the beacon sink. */
export function setTelemetrySink(custom: TelemetrySink | null): void {
  sink = custom;
}

function scheduleFlush(): void {
  if (flushTimer !== null || typeof setTimeout !== 'function') return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushTelemetry();
  }, FLUSH_DELAY_MS);
  if (typeof flushTimer === 'object' && 'unref' in flushTimer) {
    (flushTimer as { unref: () => void }).unref();
  }
}

/** Record a telemetry event (buffered; flushed on a timer, at capacity, or hide). */
export function track(event: TelemetryInput): void {
  buffer.push({ ...event, at: new Date().toISOString() });
  if (buffer.length >= MAX_BUFFER) {
    flushTelemetry();
    return;
  }
  scheduleFlush();
}

/** Send the buffered batch now. No-op when empty. */
export function flushTelemetry(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const events = buffer.splice(0, buffer.length);
  (sink ?? defaultSink)(events);
}

/** Flush buffered telemetry when the page is hidden. Returns teardown. */
export function initTelemetry(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const onHide = (): void => {
    if (document.visibilityState === 'hidden') flushTelemetry();
  };
  document.addEventListener('visibilitychange', onHide);
  return () => document.removeEventListener('visibilitychange', onHide);
}

/** Reset buffer + sink (tests). */
export function resetTelemetry(): void {
  buffer = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  sink = null;
}
