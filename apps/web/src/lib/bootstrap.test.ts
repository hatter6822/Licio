// SPDX-License-Identifier: AGPL-3.0-or-later
import { FAIL_CLOSED_FLAGS, type UserContext } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    fetchFeatureFlags: vi.fn(),
    fetchAuthStatus: vi.fn(),
    fetchSettings: vi.fn(),
  };
});

const api = await import('./api.js');
const { applySignalPolicy, confirmSession, hydrateFeatureFlags, startRuntime } = await import(
  './bootstrap.js'
);
const { useFeatureFlagStore } = await import('../stores/feature-flags.js');
const { useAuthStore } = await import('../stores/auth.js');
const { setSignalProcessor } = await import('../signals/runtime.js');
const { SignalProcessor } = await import('../signals/processor.js');

const USER: UserContext = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'ada',
  display_name: 'Ada',
  account_state: 'active',
  locale: 'en',
};

beforeEach(() => {
  vi.clearAllMocks();
  useFeatureFlagStore.getState().reset();
  useAuthStore.getState().logout();
  setSignalProcessor(new SignalProcessor());
});

afterEach(() => {
  setSignalProcessor(null);
});

describe('hydrateFeatureFlags', () => {
  it('enables flags from a valid server response', async () => {
    vi.mocked(api.fetchFeatureFlags).mockResolvedValue({
      cryptoEnabled: true,
      governanceEnabled: false,
      regionFlags: {},
      content: FAIL_CLOSED_FLAGS.content,
    });
    await hydrateFeatureFlags();
    expect(useFeatureFlagStore.getState().flags.cryptoEnabled).toBe(true);
  });

  it('fails closed when the flag endpoint errors', async () => {
    vi.mocked(api.fetchFeatureFlags).mockRejectedValue(new Error('offline'));
    await hydrateFeatureFlags();
    expect(useFeatureFlagStore.getState().flags.cryptoEnabled).toBe(false);
    expect(useFeatureFlagStore.getState().hydrated).toBe(true);
  });
});

describe('confirmSession', () => {
  it('sets the user when authenticated', async () => {
    vi.mocked(api.fetchAuthStatus).mockResolvedValue({ authenticated: true, user: USER });
    await confirmSession();
    expect(useAuthStore.getState().user).toEqual(USER);
  });

  it('expires an optimistic session when the server says unauthenticated', async () => {
    useAuthStore.getState().setAuthenticated(USER);
    vi.mocked(api.fetchAuthStatus).mockResolvedValue({ authenticated: false });
    await confirmSession();
    expect(useAuthStore.getState().status).toBe('session-expired');
  });

  it('keeps optimistic state when the check fails (offline)', async () => {
    useAuthStore.getState().setAuthenticated(USER);
    vi.mocked(api.fetchAuthStatus).mockRejectedValue(new Error('offline'));
    await confirmSession();
    expect(useAuthStore.getState().status).toBe('authenticated');
  });
});

describe('applySignalPolicy', () => {
  it('disables collection when personalization is off', async () => {
    const processor = new SignalProcessor();
    const spy = vi.spyOn(processor, 'setCollectionPolicy');
    setSignalProcessor(processor);
    vi.mocked(api.fetchSettings).mockResolvedValue({
      feed_mode: 'balanced',
      personalization_enabled: false,
      privacy_level: 'standard',
      theme: 'system',
      reduced_motion: 'system',
    });
    await applySignalPolicy();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ collect: false }));
  });

  it('falls back to defaults for a SIGNED-IN user when settings fail to load', async () => {
    const processor = new SignalProcessor();
    const spy = vi.spyOn(processor, 'setCollectionPolicy');
    setSignalProcessor(processor);
    useAuthStore.getState().setAuthenticated(USER);
    vi.mocked(api.fetchSettings).mockRejectedValue(new Error('offline'));
    await applySignalPolicy();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ collect: true }));
  });

  it('never collects for an anonymous session (WS-E: uploads are authenticated)', async () => {
    const processor = new SignalProcessor();
    const spy = vi.spyOn(processor, 'setCollectionPolicy');
    setSignalProcessor(processor);
    vi.mocked(api.fetchSettings).mockRejectedValue(new Error('offline'));
    await applySignalPolicy();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ collect: false }));
  });

  it('does NOT collect when the session is expired but a user is retained', async () => {
    // expireSession() keeps `user` for the UI but there is no valid session
    // cookie, so an upload would 401 at the WS-E ingestion boundary. Collection
    // must be gated on the live session status, not the retained user object
    // (regression: the 401-on-every-story-interaction bug).
    const processor = new SignalProcessor();
    const spy = vi.spyOn(processor, 'setCollectionPolicy');
    setSignalProcessor(processor);
    useAuthStore.getState().setAuthenticated(USER);
    useAuthStore.getState().expireSession();
    vi.mocked(api.fetchSettings).mockResolvedValue({
      feed_mode: 'balanced',
      personalization_enabled: true,
      privacy_level: 'standard',
      theme: 'system',
      reduced_motion: 'system',
    });
    await applySignalPolicy();
    // The user context is still present (UI needs it) ...
    expect(useAuthStore.getState().user).not.toBeNull();
    // ... but collection is off because the session is not live.
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ collect: false }));
  });

  it('re-reads auth AFTER settings load: mid-flight expiry disables collection', async () => {
    // The session expires while fetchSettings() is in flight. A pre-await snapshot
    // of the user id would re-enable collection for a now-dead session; reading the
    // effective id after the await keeps this stale invocation correct (collect:false).
    type Settings = Awaited<ReturnType<typeof api.fetchSettings>>;
    const settings: Settings = {
      feed_mode: 'balanced',
      personalization_enabled: true,
      privacy_level: 'standard',
      theme: 'system',
      reduced_motion: 'system',
    };
    const processor = new SignalProcessor();
    const spy = vi.spyOn(processor, 'setCollectionPolicy');
    setSignalProcessor(processor);
    useAuthStore.getState().setAuthenticated(USER);

    let resolveSettings: (value: Settings) => void = () => undefined;
    vi.mocked(api.fetchSettings).mockReturnValue(
      new Promise<Settings>((resolve) => {
        resolveSettings = resolve;
      }),
    );

    const pending = applySignalPolicy();
    // Expiry lands while the settings request is still in flight.
    useAuthStore.getState().expireSession();
    resolveSettings(settings);
    await pending;

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ collect: false }));
  });
});

describe('startRuntime', () => {
  it('wires the runtime and returns a teardown that does not throw', () => {
    vi.mocked(api.fetchFeatureFlags).mockResolvedValue({
      cryptoEnabled: false,
      governanceEnabled: false,
      regionFlags: {},
      content: FAIL_CLOSED_FLAGS.content,
    });
    vi.mocked(api.fetchAuthStatus).mockResolvedValue({ authenticated: false });
    vi.mocked(api.fetchSettings).mockResolvedValue({
      feed_mode: 'balanced',
      personalization_enabled: true,
      privacy_level: 'standard',
      theme: 'system',
      reduced_motion: 'system',
    });
    const teardown = startRuntime();
    expect(typeof teardown).toBe('function');
    expect(() => teardown()).not.toThrow();
  });
});
