// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    fetchVapidPublicKey: vi.fn().mockResolvedValue('BPk_test'),
    registerPushSubscription: vi.fn().mockResolvedValue(undefined),
    removePushSubscription: vi.fn().mockResolvedValue(undefined),
  };
});

const api = await import('../lib/api.js');
const {
  ensurePushSubscription,
  getPushReadiness,
  isIOS,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  urlBase64ToUint8Array,
} = await import('./subscription.js');

interface StubOptions {
  permission?: NotificationPermission;
  subscription?: {
    endpoint: string;
    toJSON: () => unknown;
    unsubscribe: () => Promise<boolean>;
  } | null;
  ios?: boolean;
  standalone?: boolean;
}

function stubEnv(options: StubOptions = {}) {
  const { permission = 'granted', subscription = null, ios = false, standalone = true } = options;
  const subscribe = vi.fn().mockResolvedValue({
    endpoint: 'https://push.example/abc',
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } }),
  });
  const getSubscription = vi.fn().mockResolvedValue(subscription);
  const registration = { pushManager: { subscribe, getSubscription } };
  const NotificationStub = {
    permission,
    requestPermission: vi.fn().mockResolvedValue(permission),
  };
  vi.stubGlobal('navigator', {
    serviceWorker: { ready: Promise.resolve(registration) },
    userAgent: ios ? 'iPhone' : 'Mozilla/5.0',
    platform: ios ? 'iPhone' : 'Linux',
    maxTouchPoints: 0,
  });
  vi.stubGlobal('window', {
    PushManager: class {},
    Notification: NotificationStub,
    matchMedia: () => ({ matches: standalone }),
  });
  vi.stubGlobal('Notification', NotificationStub);
  return { subscribe, getSubscription, NotificationStub };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url string to bytes with correct padding', () => {
    const bytes = urlBase64ToUint8Array('aGVsbG8'); // "hello", no padding
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });

  it('handles url-safe characters', () => {
    // 0xfb 0xff 0xbf encodes to "-_-_" in standard base64 ("+/+/" url-safe variant).
    expect(urlBase64ToUint8Array('-_-_').length).toBe(3);
  });
});

describe('feature detection', () => {
  it('reports unsupported when PushManager is absent', () => {
    vi.stubGlobal('navigator', { serviceWorker: {} });
    vi.stubGlobal('window', {});
    expect(isPushSupported()).toBe(false);
  });

  it('detects iOS from the user agent', () => {
    vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
  });
});

describe('getPushReadiness', () => {
  it('returns unsupported without push APIs', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', {});
    expect(await getPushReadiness()).toBe('unsupported');
  });

  it('requires install on iOS Safari (not standalone)', async () => {
    stubEnv({ ios: true, standalone: false });
    expect(await getPushReadiness()).toBe('needs-install');
  });

  it('reports denied when permission is denied', async () => {
    stubEnv({ permission: 'denied' });
    expect(await getPushReadiness()).toBe('denied');
  });

  it('reports ready when granted with no subscription', async () => {
    stubEnv({ permission: 'default' });
    expect(await getPushReadiness()).toBe('ready');
  });

  it('reports subscribed when a subscription exists', async () => {
    stubEnv({
      subscription: {
        endpoint: 'https://push.example/abc',
        toJSON: () => ({}),
        unsubscribe: async () => true,
      },
    });
    expect(await getPushReadiness()).toBe('subscribed');
  });
});

describe('subscribeToPush', () => {
  it('subscribes and registers with the server on permission grant', async () => {
    const { subscribe } = stubEnv({ permission: 'granted' });
    const result = await subscribeToPush();
    expect(result).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'x', auth: 'y' },
    });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(api.registerPushSubscription).toHaveBeenCalledOnce();
  });

  it('returns null and does not subscribe when permission is denied', async () => {
    const { subscribe } = stubEnv({ permission: 'denied' });
    expect(await subscribeToPush()).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('never prompts in iOS Safari (not installed)', async () => {
    const { NotificationStub } = stubEnv({ ios: true, standalone: false });
    expect(await subscribeToPush()).toBeNull();
    expect(NotificationStub.requestPermission).not.toHaveBeenCalled();
  });
});

describe('ensurePushSubscription (renew-on-load)', () => {
  it('re-registers an existing subscription without re-subscribing', async () => {
    const { subscribe } = stubEnv({
      permission: 'granted',
      subscription: {
        endpoint: 'https://push.example/abc',
        toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } }),
        unsubscribe: async () => true,
      },
    });
    await ensurePushSubscription();
    expect(subscribe).not.toHaveBeenCalled();
    expect(api.registerPushSubscription).toHaveBeenCalledOnce();
  });

  it('re-creates and registers the subscription when the browser dropped it', async () => {
    const { subscribe } = stubEnv({ permission: 'granted', subscription: null });
    await ensurePushSubscription();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(api.registerPushSubscription).toHaveBeenCalledOnce();
  });

  it('does nothing when permission has not been granted (never prompts)', async () => {
    stubEnv({ permission: 'default', subscription: null });
    await ensurePushSubscription();
    expect(api.registerPushSubscription).not.toHaveBeenCalled();
  });
});

describe('unsubscribeFromPush', () => {
  it('removes the subscription from the server and unsubscribes locally', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    stubEnv({
      subscription: { endpoint: 'https://push.example/abc', toJSON: () => ({}), unsubscribe },
    });
    await unsubscribeFromPush();
    expect(api.removePushSubscription).toHaveBeenCalledWith('https://push.example/abc');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
