// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { SignalProcessor } from './processor.js';
import { getSignalProcessor, setSignalProcessor } from './runtime.js';

afterEach(() => {
  setSignalProcessor(null);
});

describe('signal-processor runtime', () => {
  it('lazily creates a single shared processor', () => {
    const first = getSignalProcessor();
    expect(first).toBeInstanceOf(SignalProcessor);
    expect(getSignalProcessor()).toBe(first);
  });

  it('can be replaced (tests)', () => {
    const replacement = new SignalProcessor();
    setSignalProcessor(replacement);
    expect(getSignalProcessor()).toBe(replacement);
  });
});
