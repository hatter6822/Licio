// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.5f — the shared kill-switch substrate the five emergency switches
// (WS-L.3.5a-e) route through: ONE durable registry (the shared runtime-config
// store — Postgres-backed in production), deterministic scope precedence
// (global > region > room), immediate effect (the hot path reads the store on
// every decision; no cache TTL), an immutable audit entry for every
// activation/deactivation, and a TWO-PERSON deactivation flow (request by one
// operator, confirm by a DIFFERENT operator).
//
// Fail-closed semantics (mirroring the WS-I.4.1a ranking kill switch): an
// UNREADABLE or MALFORMED stored registry treats EVERY switch as ENGAGED
// GLOBALLY — a corrupt emergency-control surface must degrade to "financial
// surface off", never to "assume it is fine".  An ABSENT key is the normal
// all-inactive state.  Region scope matches the requester's self-declared
// locale region (§19.1 — the platform never reads a network address); a
// request whose region is UNKNOWN is treated as inside every engaged region
// scope (fail-closed: we cannot prove it is outside).

import {
  KILL_SWITCH_IDS,
  type KillSwitchId,
  type KillSwitchReleaseCard,
  type KillSwitchScopes,
  killSwitchReleaseCardSchema,
  killSwitchScopesSchema,
} from '@licio/shared';
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';
import type { AuditStore } from '../identity/audit.js';

export const KNOMOSIS_KILLSWITCH_CONFIG_KEY = 'knomosis.killswitch';

const switchEntrySchema = z
  .object({
    scopes: killSwitchScopesSchema,
    release_card: killSwitchReleaseCardSchema.nullable(),
    engaged_at: z.string().nullable(),
    deactivation_requested_by: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type KillSwitchEntry = z.infer<typeof switchEntrySchema>;

const registrySchema = z
  .object({
    switches: z.record(z.enum(KILL_SWITCH_IDS), switchEntrySchema),
    updated_at: z.string(),
  })
  .strict();
export type KillSwitchRegistry = z.infer<typeof registrySchema>;

export const INACTIVE_ENTRY: KillSwitchEntry = {
  scopes: { global: false, regions: [], room_ids: [] },
  release_card: null,
  engaged_at: null,
  deactivation_requested_by: null,
};

export function emptyRegistry(nowIso: string): KillSwitchRegistry {
  const switches = {} as Record<KillSwitchId, KillSwitchEntry>;
  for (const id of KILL_SWITCH_IDS) switches[id] = structuredClone(INACTIVE_ENTRY);
  return { switches, updated_at: nowIso };
}

/** Read the registry; null ⇒ all inactive, 'invalid' ⇒ fail closed (all on). */
export async function readKillSwitchRegistry(
  configStore: PwattConfigStore,
): Promise<KillSwitchRegistry | null | 'invalid'> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await configStore.get(KNOMOSIS_KILLSWITCH_CONFIG_KEY);
  } catch {
    return 'invalid';
  }
  if (raw === null) return null;
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) return 'invalid';
  // Every switch id must be present — a partial registry is malformed.
  for (const id of KILL_SWITCH_IDS) {
    if (parsed.data.switches[id] === undefined) return 'invalid';
  }
  return parsed.data;
}

export interface KillSwitchRequestContext {
  /** Soft room scope target (absent for non-room surfaces). */
  roomId?: string | undefined;
  /** Requester's self-declared locale region (BCP-47 subtag) or null=unknown. */
  region?: string | null | undefined;
}

export type KillSwitchDecision =
  | { engaged: false }
  | { engaged: true; scope: 'global' | 'region' | 'room' | 'unreadable_state' };

/**
 * Decide whether `switchId` blocks THIS request (WS-L.3.5f precedence:
 * global > region > room; any engaged scope covering the request blocks it).
 * Reads the store directly — no cache — so activation is immediate.
 */
export async function killSwitchDecision(
  configStore: PwattConfigStore,
  switchId: KillSwitchId,
  context: KillSwitchRequestContext = {},
): Promise<KillSwitchDecision> {
  const registry = await readKillSwitchRegistry(configStore);
  if (registry === null) return { engaged: false };
  if (registry === 'invalid') return { engaged: true, scope: 'unreadable_state' };

  const entry = registry.switches[switchId];
  if (entry.scopes.global) return { engaged: true, scope: 'global' };
  if (entry.scopes.regions.length > 0) {
    const region = context.region ?? null;
    // Unknown region ⇒ treated as inside every engaged region scope.
    if (region === null || entry.scopes.regions.includes(region)) {
      return { engaged: true, scope: 'region' };
    }
  }
  if (context.roomId !== undefined && entry.scopes.room_ids.includes(context.roomId)) {
    return { engaged: true, scope: 'room' };
  }
  return { engaged: false };
}

export interface KillSwitchAdminDeps {
  configStore: PwattConfigStore;
  audit: AuditStore;
  now: () => number;
  log: (event: string, meta: Record<string, unknown>) => void;
}

export type KillSwitchAdminResult =
  | { ok: true; entry: KillSwitchEntry }
  | {
      ok: false;
      code: 'registry_unreadable' | 'not_engaged' | 'no_pending_request' | 'same_operator';
      message: string;
    };

async function loadOrInit(deps: KillSwitchAdminDeps): Promise<KillSwitchRegistry | 'invalid'> {
  const registry = await readKillSwitchRegistry(deps.configStore);
  if (registry === 'invalid') return 'invalid';
  return registry ?? emptyRegistry(new Date(deps.now()).toISOString());
}

async function persist(deps: KillSwitchAdminDeps, registry: KillSwitchRegistry): Promise<void> {
  registry.updated_at = new Date(deps.now()).toISOString();
  await deps.configStore.set(KNOMOSIS_KILLSWITCH_CONFIG_KEY, registry);
}

/** Activate a switch (immediate; audited).  Overwrites the prior scopes. */
export async function activateKillSwitch(
  deps: KillSwitchAdminDeps,
  input: {
    switchId: KillSwitchId;
    scopes: KillSwitchScopes;
    releaseCard: KillSwitchReleaseCard;
    actorUserId: string;
    reason: string;
  },
): Promise<KillSwitchAdminResult> {
  const registry = await loadOrInit(deps);
  if (registry === 'invalid') {
    // A corrupt registry is already failing closed; refuse to overwrite it
    // silently — operators must inspect before re-arming.
    return {
      ok: false,
      code: 'registry_unreadable',
      message: 'The stored kill-switch registry is unreadable (all switches fail closed).',
    };
  }
  const entry: KillSwitchEntry = {
    scopes: input.scopes,
    release_card: input.releaseCard,
    engaged_at: new Date(deps.now()).toISOString(),
    deactivation_requested_by: null,
  };
  registry.switches[input.switchId] = entry;
  await persist(deps, registry);
  await deps.audit.append({
    actorUserId: input.actorUserId,
    eventType: 'knomosis_killswitch_change',
    targetRef: input.switchId,
    context: {
      setting: 'activate',
      new_value: JSON.stringify(input.scopes).slice(0, 256),
      reason: input.reason.slice(0, 256),
    },
  });
  deps.log('knomosis.killswitch.changed', {
    state: 'activated',
    switch_id: input.switchId,
    global: input.scopes.global,
    regions: input.scopes.regions.length,
    rooms: input.scopes.room_ids.length,
  });
  return { ok: true, entry };
}

/** Step 1 of the two-person deactivation: record the request (audited). */
export async function requestKillSwitchDeactivation(
  deps: KillSwitchAdminDeps,
  input: { switchId: KillSwitchId; actorUserId: string; reason: string },
): Promise<KillSwitchAdminResult> {
  const registry = await loadOrInit(deps);
  if (registry === 'invalid') {
    return {
      ok: false,
      code: 'registry_unreadable',
      message: 'The stored kill-switch registry is unreadable (all switches fail closed).',
    };
  }
  const entry = registry.switches[input.switchId];
  const engaged =
    entry.scopes.global || entry.scopes.regions.length > 0 || entry.scopes.room_ids.length > 0;
  if (!engaged) {
    return { ok: false, code: 'not_engaged', message: 'The switch is not engaged.' };
  }
  entry.deactivation_requested_by = input.actorUserId;
  await persist(deps, registry);
  await deps.audit.append({
    actorUserId: input.actorUserId,
    eventType: 'knomosis_killswitch_change',
    targetRef: input.switchId,
    context: { setting: 'request_deactivation', reason: input.reason.slice(0, 256) },
  });
  deps.log('knomosis.killswitch.changed', {
    state: 'deactivation_requested',
    switch_id: input.switchId,
  });
  return { ok: true, entry: structuredClone(entry) };
}

/**
 * Step 2: a DIFFERENT operator confirms — only then does the switch release
 * (WS-L.3.5f: a single operator can never unilaterally disable a switch).
 */
export async function confirmKillSwitchDeactivation(
  deps: KillSwitchAdminDeps,
  input: { switchId: KillSwitchId; actorUserId: string; reason: string },
): Promise<KillSwitchAdminResult> {
  const registry = await loadOrInit(deps);
  if (registry === 'invalid') {
    return {
      ok: false,
      code: 'registry_unreadable',
      message: 'The stored kill-switch registry is unreadable (all switches fail closed).',
    };
  }
  const entry = registry.switches[input.switchId];
  if (entry.deactivation_requested_by === null) {
    return {
      ok: false,
      code: 'no_pending_request',
      message: 'No deactivation request is pending for this switch.',
    };
  }
  if (entry.deactivation_requested_by === input.actorUserId) {
    return {
      ok: false,
      code: 'same_operator',
      message: 'Deactivation must be confirmed by a different operator (two-person rule).',
    };
  }
  registry.switches[input.switchId] = structuredClone(INACTIVE_ENTRY);
  await persist(deps, registry);
  await deps.audit.append({
    actorUserId: input.actorUserId,
    eventType: 'knomosis_killswitch_change',
    targetRef: input.switchId,
    context: {
      setting: 'confirm_deactivation',
      previous_value: entry.deactivation_requested_by,
      reason: input.reason.slice(0, 256),
    },
  });
  deps.log('knomosis.killswitch.changed', {
    state: 'deactivated',
    switch_id: input.switchId,
  });
  return { ok: true, entry: structuredClone(INACTIVE_ENTRY) };
}
