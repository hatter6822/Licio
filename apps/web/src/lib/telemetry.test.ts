// SPDX-License-Identifier: AGPL-3.0-or-later
import { telemetryBatchSchema } from '@licio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushTelemetry, resetTelemetry, setTelemetrySink, track } from './telemetry.js';

afterEach(() => {
  resetTelemetry();
  vi.unstubAllGlobals();
});

describe('telemetry', () => {
  it('buffers events and flushes them to the sink with a timestamp', () => {
    const sink = vi.fn();
    setTelemetrySink(sink);
    track({ name: 'web_vital', metric: 'LCP', value: 1800, rating: 'good' });
    track({ name: 'navigation', bucket: '/stories/$storyId', value: 42 });
    expect(sink).not.toHaveBeenCalled(); // buffered until flush
    flushTelemetry();
    expect(sink).toHaveBeenCalledOnce();
    const events = sink.mock.calls[0]?.[0];
    expect(events).toHaveLength(2);
    expect(events[0].at).toBeDefined();
    // The flushed batch is schema-valid (privacy-safe shape).
    expect(() => telemetryBatchSchema.parse({ events })).not.toThrow();
  });

  it('is a no-op to flush an empty buffer', () => {
    const sink = vi.fn();
    setTelemetrySink(sink);
    flushTelemetry();
    expect(sink).not.toHaveBeenCalled();
  });

  it('auto-flushes when the buffer reaches capacity', () => {
    const sink = vi.fn();
    setTelemetrySink(sink);
    for (let i = 0; i < 50; i += 1) track({ name: 'navigation', bucket: '/' });
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]?.[0]).toHaveLength(50);
  });

  it('only emits the closed set of event shapes (route patterns, not paths)', () => {
    const sink = vi.fn();
    setTelemetrySink(sink);
    track({ name: 'route_guard', metric: 'redirected' });
    flushTelemetry();
    const [event] = sink.mock.calls[0]?.[0] ?? [];
    expect(event.name).toBe('route_guard');
    expect(event.metric).toBe('redirected');
  });

  it('delivers a re-validated batch via sendBeacon (the real default sink)', () => {
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    setTelemetrySink(null); // restore the real beacon sink
    track({ name: 'navigation', bucket: '/stories/$storyId', value: 12 });
    flushTelemetry();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(String(beacon.mock.calls[0]?.[0])).toContain('/v1/telemetry');
    expect(beacon.mock.calls[0]?.[1]).toBeInstanceOf(Blob);
  });

  it('falls back to a keepalive fetch when sendBeacon is unavailable', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('navigator', {}); // no sendBeacon
    vi.stubGlobal('fetch', fetchMock);
    setTelemetrySink(null);
    track({ name: 'web_vital', metric: 'LCP', value: 100, rating: 'good' });
    flushTelemetry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe('POST');
  });
});
