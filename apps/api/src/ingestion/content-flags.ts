// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.6.2 — fail-closed rollout flags for the WS-Q user-visible surface, so
// behavior rolls out/back independently of the additive schema (SPEC §30.8/30.9):
//
//   • content.media_posts_enabled       — image/video submission (the new types).
//   • content.in_room_visibility_enabled — the public/in-room AUTHOR choice in a
//       PUBLIC room. OFF ⇒ public rooms behave pre-WS-Q (all content public);
//       private rooms STILL force room_only (that forcing is `deriveStoryVisibility`,
//       NOT this flag — containment is never flaggable).
//   • rooms.binary_visibility_ui        — the new room-control UI (client-read).
//
// Defaults are ON (WS-Q is the live model); a steward may flip a flag OFF to roll
// back. FAIL-CLOSED: an unreadable store or a garbled value yields OFF (the safe
// pre-WS-Q state) — never a half-applied flag.
//
// What is DELIBERATELY NOT flaggable: the distribution-side gate
// (`filterByVisibility`) and the item read bar (`storyReadableByUser`) are
// unconditionally on — there is no key that disables them, since doing so could
// leak in-room content. The containment-not-flaggable test asserts this.
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';

export interface ContentFeatureFlags {
  mediaPostsEnabled: boolean;
  inRoomVisibilityEnabled: boolean;
  binaryVisibilityUi: boolean;
}

export const DEFAULT_CONTENT_FLAGS: ContentFeatureFlags = {
  mediaPostsEnabled: true,
  inRoomVisibilityEnabled: true,
  binaryVisibilityUi: true,
};

/** The steward-facing flag name for each field (the shared config store key). */
export const CONTENT_FLAG_STORE_KEYS: Record<keyof ContentFeatureFlags, string> = {
  mediaPostsEnabled: 'content.media_posts_enabled',
  inRoomVisibilityEnabled: 'content.in_room_visibility_enabled',
  binaryVisibilityUi: 'rooms.binary_visibility_ui',
};

const STORE_KEY_TO_FIELD = new Map<string, keyof ContentFeatureFlags>(
  (Object.entries(CONTENT_FLAG_STORE_KEYS) as Array<[keyof ContentFeatureFlags, string]>).map(
    ([field, key]) => [key, field],
  ),
);

export const CONTENT_FLAG_NAMES = Object.values(CONTENT_FLAG_STORE_KEYS);

const flagSchema = z.boolean();

/** Validate one steward write; returns an error message (→ 422) or null. */
export function validateContentFlagValue(name: string, value: unknown): string | null {
  if (!STORE_KEY_TO_FIELD.has(name)) return `unknown content flag "${name}"`;
  return flagSchema.safeParse(value).success ? null : `"${name}" must be a boolean`;
}

/**
 * Load the effective flags: defaults overlaid with stored valid overrides.
 * Values are `{ value }` envelopes (the shared store shape). FAIL-CLOSED: a
 * missing key keeps the default; an INVALID stored value is reported and forced
 * OFF; a store read that THROWS forces every flag OFF.
 */
export async function loadContentFlags(
  configStore: PwattConfigStore,
  onInvalid: (name: string, problem: string) => void = () => {},
): Promise<ContentFeatureFlags> {
  const flags: ContentFeatureFlags = { ...DEFAULT_CONTENT_FLAGS };
  for (const field of Object.keys(flags) as Array<keyof ContentFeatureFlags>) {
    const name = CONTENT_FLAG_STORE_KEYS[field];
    let stored: Record<string, unknown> | null;
    try {
      stored = await configStore.get(name);
    } catch (error) {
      // Unreadable store ⇒ fail closed (every flag OFF).
      onInvalid(name, error instanceof Error ? error.message : 'store unreadable');
      flags[field] = false;
      continue;
    }
    if (stored === null || !Object.hasOwn(stored, 'value')) continue; // no override → default
    const value = stored['value'];
    if (typeof value !== 'boolean') {
      onInvalid(name, `"${name}" must be a boolean`);
      flags[field] = false; // garbled override ⇒ fail closed for this flag
      continue;
    }
    flags[field] = value;
  }
  return flags;
}

/** Persist one validated flag by FIELD — the single write path, so the
 *  `CONTENT_FLAG_STORE_KEYS` mapping that {@link loadContentFlags} reads is
 *  also the mapping every writer goes through. */
export async function storeContentFlagValue(
  configStore: PwattConfigStore,
  field: keyof ContentFeatureFlags,
  value: boolean,
): Promise<void> {
  await configStore.set(CONTENT_FLAG_STORE_KEYS[field], { value });
}

/** Persist one flag by its steward-facing NAME (the admin surface writes here);
 *  returns false for an unknown name (the caller maps that to a 422).
 *  Resolves the name to its field and DELEGATES, rather than re-deriving the
 *  store key, so name-keyed and field-keyed writes cannot diverge. */
export async function setContentFlagByName(
  configStore: PwattConfigStore,
  name: string,
  value: boolean,
): Promise<boolean> {
  const field = STORE_KEY_TO_FIELD.get(name);
  if (field === undefined) return false;
  await storeContentFlagValue(configStore, field, value);
  return true;
}
