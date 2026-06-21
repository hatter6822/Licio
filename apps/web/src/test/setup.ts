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
import { afterEach, beforeEach, expect } from 'vitest';
import { resetTelemetry, setTelemetrySink } from '../lib/telemetry.js';

expect.extend(toHaveNoViolations);

// Telemetry must never touch the network or leave timers pending in unit tests.
// A no-op sink before each test makes `track()` inert; resetting after clears the
// buffer + any scheduled flush. (Telemetry-specific tests set their own sink.)
beforeEach(() => {
  setTelemetrySink(() => undefined);
});
afterEach(() => {
  resetTelemetry();
});

// jsdom has no layout/scroll engine and ships `scrollTo` as a stub that logs
// "Not implemented" and throws. Components that restore scroll position
// (useScrollLock) call it as a safety net; replace it with a no-op so tests
// stay free of that noise. Real browsers keep the genuine implementation.
Object.defineProperty(window, 'scrollTo', {
  value: () => undefined,
  writable: true,
  configurable: true,
});

// jsdom does not honor an anchor's `download` attribute: a real browser saves the
// blob and never navigates, but jsdom treats a programmatic `anchor.click()` on a
// `download` link as a navigation it cannot perform, logging "Not implemented:
// navigation to another Document". Our file-download helpers (the LCAP
// `.licio-bundle` export, governance model bundles, the DSAR archive) create and
// click exactly such an anchor. Mirror the browser: a `download` anchor's click is a
// no-op navigation in tests. Non-download anchors keep jsdom's behavior, and a
// per-instance `click` override (as the DSAR-export test uses) still shadows this.
const anchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
  if (this.hasAttribute('download')) return;
  anchorClick.call(this);
};

afterEach(() => {
  cleanup();
});
