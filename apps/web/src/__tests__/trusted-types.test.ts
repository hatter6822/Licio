// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initTrustedTypes } from '../security/trusted-types.js';

type PolicyHandlers = Record<string, (...args: string[]) => string>;

function createMockTT() {
  const policies = new Map<string, PolicyHandlers>();
  return {
    mock: {
      createPolicy: (name: string, policy: PolicyHandlers) => {
        policies.set(name, policy);
      },
    },
    policies,
  };
}

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

  it('creates both default and dompurify policies', () => {
    const { mock, policies } = createMockTT();
    vi.stubGlobal('window', { ...window, trustedTypes: mock });

    initTrustedTypes();

    expect(policies.has('default')).toBe(true);
    expect(policies.has('dompurify')).toBe(true);
  });

  it('default policy blocks HTML assignment', () => {
    const { mock, policies } = createMockTT();
    vi.stubGlobal('window', { ...window, trustedTypes: mock });

    initTrustedTypes();

    const defaultPolicy = policies.get('default');
    expect(defaultPolicy?.['createHTML']).toBeDefined();
    expect(() => defaultPolicy?.['createHTML']?.('<div>xss</div>')).toThrow(
      'Direct HTML assignment is blocked by Trusted Types policy',
    );
  });

  it('default policy blocks script creation', () => {
    const { mock, policies } = createMockTT();
    vi.stubGlobal('window', { ...window, trustedTypes: mock });

    initTrustedTypes();

    const defaultPolicy = policies.get('default');
    expect(defaultPolicy?.['createScript']).toBeDefined();
    expect(() => defaultPolicy?.['createScript']?.('alert(1)')).toThrow(
      'Direct script creation is blocked by Trusted Types policy',
    );
  });

  it('default policy allows same-origin script URLs', () => {
    const { mock, policies } = createMockTT();
    vi.stubGlobal('window', {
      ...window,
      trustedTypes: mock,
      location: { origin: 'http://localhost:5173' },
    });

    initTrustedTypes();

    const defaultPolicy = policies.get('default');
    expect(defaultPolicy?.['createScriptURL']?.('http://localhost:5173/script.js')).toBe(
      'http://localhost:5173/script.js',
    );
    expect(defaultPolicy?.['createScriptURL']?.('/relative/path.js')).toBe('/relative/path.js');
  });

  it('default policy blocks external-origin script URLs', () => {
    const { mock, policies } = createMockTT();
    vi.stubGlobal('window', {
      ...window,
      trustedTypes: mock,
      location: { origin: 'http://localhost:5173' },
    });

    initTrustedTypes();

    const defaultPolicy = policies.get('default');
    expect(() => defaultPolicy?.['createScriptURL']?.('https://evil.com/script.js')).toThrow(
      'Blocked script URL from external origin',
    );
  });

  it('blocks cross-origin URLs that a naive startsWith check would allow (bypass regression)', () => {
    const { mock, policies } = createMockTT();
    vi.stubGlobal('window', {
      ...window,
      trustedTypes: mock,
      location: { origin: 'http://localhost:5173' },
    });
    initTrustedTypes();
    const createScriptURL = policies.get('default')?.['createScriptURL'];

    // Each of these starts with the origin string or '/', yet resolves cross-origin.
    for (const bypass of [
      'http://localhost:5173.evil.com/x.js', // origin-suffix
      'http://localhost:5173@evil.com/x.js', // userinfo trick
      '//evil.com/x.js', // protocol-relative
      'https://evil.com/x.js',
    ]) {
      expect(() => createScriptURL?.(bypass)).toThrow();
    }
  });

  it('dompurify policy allows HTML passthrough for sanitized content', () => {
    const { mock, policies } = createMockTT();
    vi.stubGlobal('window', { ...window, trustedTypes: mock });

    initTrustedTypes();

    const dpPolicy = policies.get('dompurify');
    expect(dpPolicy?.['createHTML']).toBeDefined();
    expect(dpPolicy?.['createHTML']?.('<p>safe</p>')).toBe('<p>safe</p>');
  });
});
