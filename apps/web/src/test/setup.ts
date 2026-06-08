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

afterEach(() => {
  cleanup();
});
