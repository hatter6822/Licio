// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Type augmentation so jest-axe's `toHaveNoViolations` matcher is recognised on
// vitest's `expect`. jest-axe ships jest-flavoured matcher types; vitest uses a
// structurally compatible matcher interface that we extend here.
import 'vitest';

interface AxeMatchers<R = unknown> {
  toHaveNoViolations(): R;
}

declare module 'vitest' {
  // biome-ignore lint/suspicious/noExplicitAny: vitest's own Assertion generic defaults to `any`; we mirror it.
  interface Assertion<T = any> extends AxeMatchers<T> {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
