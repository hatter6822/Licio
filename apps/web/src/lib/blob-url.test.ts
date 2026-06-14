// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintObjectUrl, sanitizeBlobUrl } from './blob-url.js';

const BLOB = 'blob:https://app.example/550e8400-e29b-41d4-a716-446655440000';

describe('sanitizeBlobUrl', () => {
  it('accepts a well-formed blob: URL and returns it byte-identical', () => {
    // A clean blob handle is URI-safe, so encodeURI is a no-op and the preview
    // still loads (and revokeObjectURL still matches the value exactly).
    expect(sanitizeBlobUrl(BLOB)).toBe(BLOB);
  });

  it.each([
    ['http://example.com/x'],
    ['https://example.com/x'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
  ])('rejects the non-blob scheme %s', (raw) => {
    expect(sanitizeBlobUrl(raw)).toBeNull();
  });

  it('rejects an unparseable value (URL constructor throws)', () => {
    expect(sanitizeBlobUrl('not a url')).toBeNull();
    expect(sanitizeBlobUrl('')).toBeNull();
  });
});

describe('mintObjectUrl', () => {
  const file = new File(['x'], 'a.png', { type: 'image/png' });
  // jsdom may not implement the object-URL API; snapshot whatever it provides
  // and restore it after each case so the global URL constructor is untouched.
  const realCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const realRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

  function setObjectUrlApi(
    create: ((file: Blob) => string) | undefined,
    revoke: (url: string) => void,
  ): void {
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
  }

  afterEach(() => {
    if (realCreate) Object.defineProperty(URL, 'createObjectURL', realCreate);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (realRevoke) Object.defineProperty(URL, 'revokeObjectURL', realRevoke);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('returns the raw blob handle when createObjectURL yields a blob: URL', () => {
    const revoke = vi.fn();
    setObjectUrlApi(() => BLOB, revoke);
    expect(mintObjectUrl(file)).toBe(BLOB);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokes and returns null when createObjectURL yields a non-blob URL', () => {
    const revoke = vi.fn();
    const bad = 'https://evil.example/x';
    setObjectUrlApi(() => bad, revoke);
    expect(mintObjectUrl(file)).toBeNull();
    expect(revoke).toHaveBeenCalledWith(bad);
  });

  it('returns null when createObjectURL is unavailable', () => {
    setObjectUrlApi(undefined, vi.fn());
    expect(mintObjectUrl(file)).toBeNull();
  });
});
