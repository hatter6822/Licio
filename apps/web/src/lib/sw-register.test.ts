// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyUpdate, registerServiceWorker, SW_UPDATE_EVENT } from './sw-register.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('applyUpdate', () => {
  it('posts SKIP_WAITING to the waiting worker', () => {
    const postMessage = vi.fn();
    applyUpdate({ postMessage } as unknown as ServiceWorker);
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('is a no-op when there is no waiting worker', () => {
    expect(() => applyUpdate(null)).not.toThrow();
    expect(() => applyUpdate(undefined)).not.toThrow();
  });
});

describe('registerServiceWorker', () => {
  it('does nothing when service workers are unsupported', () => {
    vi.stubGlobal('navigator', {});
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it('registers with locked scope and watches for updates', async () => {
    const registration = {
      installing: null,
      waiting: null,
      addEventListener: vi.fn(),
    };
    const register = vi.fn().mockResolvedValue(registration);
    vi.stubGlobal('navigator', {
      serviceWorker: { register, addEventListener: vi.fn(), controller: null },
    });
    vi.stubGlobal('document', { readyState: 'complete' });

    registerServiceWorker();
    await Promise.resolve();
    await Promise.resolve();

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(registration.addEventListener).toHaveBeenCalledWith('updatefound', expect.any(Function));
  });

  it('exposes a stable update-event name', () => {
    expect(SW_UPDATE_EVENT).toBe('licio:sw-update');
  });
});
