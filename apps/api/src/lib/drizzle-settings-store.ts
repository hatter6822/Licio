// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapter for the WS-C settings sync, behind the same
// `UserSettingsStore` interface as the in-memory adapter.  Privacy: the
// settings key (a user id when signed in, else a session id) persists as a
// SHA-256 HASH — a raw session token never sits at rest; reads re-validate the
// stored JSON through the shared schema, so a corrupted row reads as absent
// (the route then serves the defaults — fail closed, never a crash).
import { createHash } from 'node:crypto';
import { type createDbClient, userSettings as userSettingsTable } from '@licio/db';
import { type UserSettings, userSettingsSchema } from '@licio/shared';
import { eq } from 'drizzle-orm';
import type { UserSettingsStore } from './user-settings.js';

type Db = ReturnType<typeof createDbClient>;

const refOf = (value: string): string => createHash('sha256').update(value).digest('hex');

export class DrizzleUserSettingsStore implements UserSettingsStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(stateKey: string): Promise<UserSettings | null> {
    const rows = await this.#db
      .select()
      .from(userSettingsTable)
      .where(eq(userSettingsTable.stateRef, refOf(stateKey)))
      .limit(1);
    const raw = rows[0]?.settings;
    if (raw === undefined) return null;
    const parsed = userSettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async set(stateKey: string, settings: UserSettings): Promise<void> {
    const values = {
      settings: settings as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    };
    await this.#db
      .insert(userSettingsTable)
      .values({ stateRef: refOf(stateKey), ...values })
      .onConflictDoUpdate({ target: userSettingsTable.stateRef, set: values });
  }

  async clear(): Promise<void> {
    await this.#db.delete(userSettingsTable);
  }
}
