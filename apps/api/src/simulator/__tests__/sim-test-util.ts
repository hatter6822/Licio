// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tiny assertion helper for the simulator tests: narrow away a nullable value
// with a runtime check (a thrown error with a clear message) rather than a
// compile-only non-null assertion, keeping the suites free of `!`.

export function req<T>(value: T | null | undefined, message = 'expected a value'): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
