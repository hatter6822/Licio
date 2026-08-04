// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one property that matters: the answer is TRUE only when a write happened.
// Every caller here reports "Copied" from it, and the environments where the
// API is missing are exactly the ones a user cannot tell apart from success.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.js';

function withClipboard(value: unknown): void {
  vi.spyOn(globalThis, 'navigator', 'get').mockReturnValue({
    clipboard: value,
  } as unknown as Navigator);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('writes and reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard({ writeText });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('reports FAILURE when the API is absent rather than resolving undefined', async () => {
    // `await navigator.clipboard?.writeText(x)` resolves here — which is how
    // every caller came to claim "Copied" in an insecure context.
    withClipboard(undefined);
    expect(await copyText('hello')).toBe(false);
  });

  it('reports failure when `clipboard` exists without `writeText`', async () => {
    withClipboard({});
    expect(await copyText('hello')).toBe(false);
  });

  it('reports failure when the write is denied', async () => {
    withClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    expect(await copyText('hello')).toBe(false);
  });
});
