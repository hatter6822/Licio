// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-C settings sync (SPEC §23.2) behind the `UserSettingsStore` boundary: the
// in-memory adapter serves dev/tests, and the production boot swaps in the
// Drizzle adapter so settings survive restarts and — keyed by USER id when
// signed in — sync across sessions and devices.  A cookieless visitor is never
// persisted server-side (the client's local persistence owns that state); the
// old shared 'anonymous' fallback key was a cross-user state bleed and is gone.
import type { UserSettings } from '@licio/shared';

export interface UserSettingsStore {
  get(stateKey: string): Promise<UserSettings | null>;
  set(stateKey: string, settings: UserSettings): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryUserSettingsStore implements UserSettingsStore {
  readonly #rows = new Map<string, UserSettings>();

  async get(stateKey: string): Promise<UserSettings | null> {
    return this.#rows.get(stateKey) ?? null;
  }

  async set(stateKey: string, settings: UserSettings): Promise<void> {
    this.#rows.set(stateKey, { ...settings });
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

let store: UserSettingsStore = new InMemoryUserSettingsStore();

/** Bind the durable adapter (production boot) or a fresh in-memory one (tests). */
export function setUserSettingsStore(next: UserSettingsStore): void {
  store = next;
}

export function getUserSettingsStore(): UserSettingsStore {
  return store;
}
