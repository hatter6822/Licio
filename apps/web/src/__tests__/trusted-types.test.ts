// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initTrustedTypes } from '../security/trusted-types.js';

describe('initTrustedTypes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early when window is undefined (SSR/Node)', () => {
    const originalWindow = globalThis.window;
    vi.stubGlobal('window', undefined);
    expect(() => initTrustedTypes()).not.toThrow();
    vi.stubGlobal('window', originalWindow);
  });

  it('returns early when trustedTypes API is not available', () => {
    expect(() => initTrustedTypes()).not.toThrow();
  });

  it('creates a default policy that blocks HTML assignment', () => {
    let capturedPolicy: Record<string, (...args: string[]) => string> = {};
    const mockTT = {
      createPolicy: (_name: string, policy: Record<string, (...args: string[]) => string>) => {
        capturedPolicy = policy;
      },
    };
    vi.stubGlobal('window', { ...window, trustedTypes: mockTT });

    initTrustedTypes();

    expect(capturedPolicy['createHTML']).toBeDefined();
    expect(() => capturedPolicy['createHTML']?.('<div>xss</div>')).toThrow(
      'Direct HTML assignment is blocked by Trusted Types policy',
    );
  });

  it('creates a default policy that blocks script creation', () => {
    let capturedPolicy: Record<string, (...args: string[]) => string> = {};
    const mockTT = {
      createPolicy: (_name: string, policy: Record<string, (...args: string[]) => string>) => {
        capturedPolicy = policy;
      },
    };
    vi.stubGlobal('window', { ...window, trustedTypes: mockTT });

    initTrustedTypes();

    expect(capturedPolicy['createScript']).toBeDefined();
    expect(() => capturedPolicy['createScript']?.('alert(1)')).toThrow(
      'Direct script creation is blocked by Trusted Types policy',
    );
  });

  it('allows same-origin script URLs', () => {
    let capturedPolicy: Record<string, (...args: string[]) => string> = {};
    const mockTT = {
      createPolicy: (_name: string, policy: Record<string, (...args: string[]) => string>) => {
        capturedPolicy = policy;
      },
    };
    vi.stubGlobal('window', {
      ...window,
      trustedTypes: mockTT,
      location: { origin: 'http://localhost:5173' },
    });

    initTrustedTypes();

    expect(capturedPolicy['createScriptURL']?.('http://localhost:5173/script.js')).toBe(
      'http://localhost:5173/script.js',
    );
    expect(capturedPolicy['createScriptURL']?.('/relative/path.js')).toBe('/relative/path.js');
  });

  it('blocks external-origin script URLs', () => {
    let capturedPolicy: Record<string, (...args: string[]) => string> = {};
    const mockTT = {
      createPolicy: (_name: string, policy: Record<string, (...args: string[]) => string>) => {
        capturedPolicy = policy;
      },
    };
    vi.stubGlobal('window', {
      ...window,
      trustedTypes: mockTT,
      location: { origin: 'http://localhost:5173' },
    });

    initTrustedTypes();

    expect(() => capturedPolicy['createScriptURL']?.('https://evil.com/script.js')).toThrow(
      'Blocked script URL from external origin',
    );
  });
});
