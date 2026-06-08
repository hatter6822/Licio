// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Vitest setup for the web workspace (jsdom environment).
// - Registers @testing-library/jest-dom matchers on vitest's `expect`.
// - Registers jest-axe's `toHaveNoViolations` matcher for accessibility assertions.
// - Ensures React Testing Library unmounts components between tests so DOM state
//   never leaks across cases (focus, portals, live regions).
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { afterEach, expect } from 'vitest';

expect.extend(toHaveNoViolations);

// jsdom has no layout/scroll engine and ships `scrollTo` as a stub that logs
// "Not implemented" and throws. Components that restore scroll position
// (useScrollLock) call it as a safety net; replace it with a no-op so tests
// stay free of that noise. Real browsers keep the genuine implementation.
Object.defineProperty(window, 'scrollTo', {
  value: () => undefined,
  writable: true,
  configurable: true,
});

afterEach(() => {
  cleanup();
});
