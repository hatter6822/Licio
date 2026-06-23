// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — SW-pinning + rotation + bundle-discovery client tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPrivateBundleUrl } from './bundle-digest.js';
import { withRotatedSigners } from './config.js';
import { resetPrivateBundleGate } from './gate.js';
import {
  activateVerifiedWorker,
  gateServiceWorkerActivation,
  installSwUpdatePinning,
} from './sw-pinning.js';

afterEach(() => {
  resetPrivateBundleGate();
  document.head.innerHTML = '';
});

describe('withRotatedSigners (post-incident key rotation, §27.5)', () => {
  it('replaces the trusted signer set and drops empty keys', () => {
    const base = {
      trustedSignerPublicKeys: ['old-key'],
      logPublicKey: 'log',
      lastTrustedSequence: 4,
    };
    const rotated = withRotatedSigners(base, ['new-key-a', '', 'new-key-b']);
    expect(rotated.trustedSignerPublicKeys).toEqual(['new-key-a', 'new-key-b']);
    expect(rotated.logPublicKey).toBe('log');
    // The sequence floor carries over unless overridden.
    expect(rotated.lastTrustedSequence).toBe(4);
  });

  it('can raise the anti-rollback floor during recovery', () => {
    const base = { trustedSignerPublicKeys: ['k'], logPublicKey: 'log' };
    const rotated = withRotatedSigners(base, ['k2'], { lastTrustedSequence: 10 });
    expect(rotated.lastTrustedSequence).toBe(10);
  });
});

describe('discoverPrivateBundleUrl', () => {
  it('finds the same-origin private-p2p module preload', () => {
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = '/assets/private-p2p-abc123.js';
    document.head.appendChild(link);
    expect(discoverPrivateBundleUrl(document)).toContain('private-p2p-abc123.js');
  });

  it('returns undefined when no private chunk is present', () => {
    expect(discoverPrivateBundleUrl(document)).toBeUndefined();
  });

  it('ignores a cross-origin script that matches the name', () => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'https://evil.example/assets/private-p2p-x.js';
    document.head.appendChild(script);
    expect(discoverPrivateBundleUrl(document)).toBeUndefined();
  });
});

describe('gateServiceWorkerActivation', () => {
  it('refuses activation on an untrusted bundle (empty signer set ⇒ lock)', async () => {
    const decision = await gateServiceWorkerActivation({
      config: { trustedSignerPublicKeys: [], logPublicKey: '' },
      // No bundle resolvable ⇒ digest cannot be proven ⇒ lock.
      resolveBundleUrl: () => undefined,
    });
    expect(decision.allowActivate).toBe(false);
  });
});

describe('activateVerifiedWorker', () => {
  it('posts the gated SKIP_WAITING with the verified flag', () => {
    const post = vi.fn();
    activateVerifiedWorker({ postMessage: post } as unknown as ServiceWorker, {
      privateBundleGated: true,
      verified: true,
    });
    expect(post).toHaveBeenCalledWith({
      type: 'SKIP_WAITING',
      privateBundleGated: true,
      privateBundleVerified: true,
    });
  });

  it('is a no-op on a null waiting worker', () => {
    expect(() =>
      activateVerifiedWorker(null, { privateBundleGated: false, verified: true }),
    ).not.toThrow();
  });
});

describe('installSwUpdatePinning (SW-update event wiring)', () => {
  const mkReg = (): ServiceWorkerRegistration =>
    ({ waiting: { postMessage: vi.fn() } }) as unknown as ServiceWorkerRegistration;

  it('public fast path: no private rooms ⇒ onActivate, never gated/locked', async () => {
    const onActivate = vi.fn();
    const onLocked = vi.fn();
    const dispose = installSwUpdatePinning({
      eventName: 'test-sw-update-public',
      onActivate,
      onLocked,
      hasPrivateRooms: () => false,
    });
    const reg = mkReg();
    window.dispatchEvent(new CustomEvent('test-sw-update-public', { detail: reg }));
    await Promise.resolve();
    expect(onActivate).toHaveBeenCalledWith(reg);
    expect(onLocked).not.toHaveBeenCalled();
    dispose();
  });

  it('private rooms + untrusted bundle ⇒ onLocked, NEVER onActivate', async () => {
    const onActivate = vi.fn();
    const onLocked = vi.fn();
    const dispose = installSwUpdatePinning({
      eventName: 'test-sw-update-locked',
      onActivate,
      onLocked,
      hasPrivateRooms: () => true,
      // Empty signer set + no resolvable bundle ⇒ the gate locks.
      deps: {
        config: { trustedSignerPublicKeys: [], logPublicKey: '' },
        resolveBundleUrl: () => undefined,
      },
    });
    window.dispatchEvent(new CustomEvent('test-sw-update-locked', { detail: mkReg() }));
    await new Promise((r) => setTimeout(r, 0)); // gateServiceWorkerActivation is async
    expect(onLocked).toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    dispose();
  });

  it('the disposer removes the listener', async () => {
    const onActivate = vi.fn();
    const dispose = installSwUpdatePinning({
      eventName: 'test-sw-update-dispose',
      onActivate,
      onLocked: vi.fn(),
      hasPrivateRooms: () => false,
    });
    dispose();
    window.dispatchEvent(new CustomEvent('test-sw-update-dispose', { detail: mkReg() }));
    await Promise.resolve();
    expect(onActivate).not.toHaveBeenCalled();
  });
});
