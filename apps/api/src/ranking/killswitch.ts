// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.4.1a — the ranking kill switch: a RUNTIME control (no deployment to
// engage) persisted in the shared runtime-config store, with graduated
// scopes (global / per-surface / per-profile). When a request matches an
// engaged scope, the feed is served by the safe fallback ranker (WS-I.4.1b).
//
// Fail-closed semantics: an UNREADABLE or MALFORMED stored state is treated
// as ENGAGED GLOBALLY (the safe fallback serves — a corrupt control surface
// must degrade to safety, never to "assume ranked serving is fine"). An
// ABSENT key is the normal disengaged state. Engage/release carry the
// Section 30.8 release-card fields (owner, trigger condition, rollback path,
// review date) and are audited by the admin route.

import { z } from 'zod';
import type { EventPipelineServices } from '../events/services.js';

export const KILLSWITCH_CONFIG_KEY = 'ranking.killswitch';

export const killSwitchStateSchema = z
  .object({
    /** Global scope: every surface serves the fallback. */
    global: z.boolean(),
    /** Per-surface scopes (front_page / room / topic). */
    surfaces: z.array(z.enum(['front_page', 'room', 'topic'])),
    /** Per-profile scopes: requests matching these profiles fall back. */
    profile_ids: z.array(z.string().min(1).max(64)),
    /** §30.8 release-card metadata for the CURRENT engagement. */
    owner: z.string().min(1).max(128),
    trigger_condition: z.string().min(1).max(512),
    rollback_path: z.string().min(1).max(512),
    review_date: z.string(),
    engaged_at: z.string(),
  })
  .strict();
export type KillSwitchState = z.infer<typeof killSwitchStateSchema>;

export type KillSwitchDecision =
  | { engaged: false }
  | { engaged: true; scope: 'global' | 'surface' | 'profile' | 'unreadable_state' };

/** The disengaged sentinel (an absent config key). */
export const KILL_SWITCH_DISENGAGED: KillSwitchDecision = { engaged: false };

/** Read the current state; null ⇒ disengaged, 'invalid' ⇒ fail closed. */
export async function readKillSwitchState(
  events: EventPipelineServices,
): Promise<KillSwitchState | null | 'invalid'> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await events.configStore.get(KILLSWITCH_CONFIG_KEY);
  } catch {
    return 'invalid';
  }
  if (raw === null) return null;
  const parsed = killSwitchStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'invalid';
}

/** Decide whether THIS request's serving must fall back (WS-I.4.1a). */
export async function killSwitchDecision(
  events: EventPipelineServices,
  surface: 'front_page' | 'room' | 'topic',
  profileId: string,
): Promise<KillSwitchDecision> {
  const state = await readKillSwitchState(events);
  if (state === null) return KILL_SWITCH_DISENGAGED;
  if (state === 'invalid') {
    // Fail closed: a corrupt kill-switch state serves the SAFE fallback.
    events.log('ranking.killswitch.unreadable', { key: KILLSWITCH_CONFIG_KEY });
    return { engaged: true, scope: 'unreadable_state' };
  }
  if (state.global) return { engaged: true, scope: 'global' };
  if (state.surfaces.includes(surface)) return { engaged: true, scope: 'surface' };
  if (state.profile_ids.includes(profileId)) return { engaged: true, scope: 'profile' };
  return KILL_SWITCH_DISENGAGED;
}

export interface EngageKillSwitchInput {
  global: boolean;
  surfaces: ReadonlyArray<'front_page' | 'room' | 'topic'>;
  profileIds: readonly string[];
  owner: string;
  triggerCondition: string;
  rollbackPath: string;
  reviewDate: string;
}

/** Engage (write) the switch. The route audits the action. */
export async function engageKillSwitch(
  events: EventPipelineServices,
  input: EngageKillSwitchInput,
  nowIso: string,
): Promise<KillSwitchState> {
  const state = killSwitchStateSchema.parse({
    global: input.global,
    surfaces: [...input.surfaces],
    profile_ids: [...input.profileIds],
    owner: input.owner,
    trigger_condition: input.triggerCondition,
    rollback_path: input.rollbackPath,
    review_date: input.reviewDate,
    engaged_at: nowIso,
  });
  await events.configStore.set(KILLSWITCH_CONFIG_KEY, state);
  events.log('ranking.killswitch.changed', {
    state: 'engaged',
    global: state.global,
    surfaces: state.surfaces,
    profile_ids: state.profile_ids,
    owner: state.owner,
  });
  return state;
}

/** Release the switch (delete by writing the disengaged sentinel). */
export async function releaseKillSwitch(
  events: EventPipelineServices,
  actorOwner: string,
): Promise<void> {
  // The config store has no delete; an explicit disengaged state would need
  // schema special-casing, so we write the canonical "everything off" state
  // — which the decision function treats as disengaged via its empty scopes.
  await events.configStore.set(KILLSWITCH_CONFIG_KEY, {
    global: false,
    surfaces: [],
    profile_ids: [],
    owner: actorOwner,
    trigger_condition: 'released',
    rollback_path: 'n/a',
    review_date: new Date(0).toISOString(),
    engaged_at: new Date(0).toISOString(),
  });
  events.log('ranking.killswitch.changed', { state: 'released', owner: actorOwner });
}
