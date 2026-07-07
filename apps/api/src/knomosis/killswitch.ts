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
  type KnomosisSignedActionType,
  killSwitchReleaseCardSchema,
  killSwitchScopesSchema,
} from '@licio/shared';
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';
import type { AuditStore } from '../identity/audit.js';

export const KNOMOSIS_KILLSWITCH_CONFIG_KEY = 'knomosis.killswitch';

/**
 * Per-switch config key.  Each of the five switches is stored under its OWN
 * key so two operators activating/deactivating DIFFERENT switches during an
 * incident never read-modify-write a shared registry blob and drop each other's
 * change (WS-L.3.5f).  A read-modify-write on ONE switch is still last-write-wins
 * (two operators fighting over the same switch is a human-coordination case), but
 * an emergency engagement of switch A can never be silently cleared by a
 * concurrent edit to switch B.
 */
export function switchConfigKey(id: KillSwitchId): string {
  return `${KNOMOSIS_KILLSWITCH_CONFIG_KEY}.${id}`;
}

/** The NARROWER emergency switch that governs each signed action type (checked
 *  in addition to the broad `action_submission` switch): a treasury-execution
 *  pause stops grant/deposit/bounty submissions, and a governance-voting pause
 *  stops proposal-signature submissions — on both the HTTP submit path AND the
 *  scheduler's resubmit sweep (WS-L.3.5c). */
export const ACTION_KILL_SWITCH: Readonly<Partial<Record<KnomosisSignedActionType, KillSwitchId>>> =
  {
    treasury_deposit: 'treasury_execution',
    grant_payout: 'treasury_execution',
    bounty_contribution: 'treasury_execution',
    proposal_sign: 'governance_voting',
  };

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

/**
 * Read ONE switch entry; null ⇒ absent (inactive), 'invalid' ⇒ fail closed for
 * that switch (a store error OR a present-but-malformed value — a corrupt
 * emergency-control surface must degrade to "engaged", never to "assume fine").
 */
export async function readSwitchEntry(
  configStore: PwattConfigStore,
  switchId: KillSwitchId,
): Promise<KillSwitchEntry | null | 'invalid'> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await configStore.get(switchConfigKey(switchId));
  } catch {
    return 'invalid';
  }
  if (raw === null) return null;
  const parsed = switchEntrySchema.safeParse(raw);
  return parsed.success ? parsed.data : 'invalid';
}

/**
 * Assemble the full registry from the per-switch keys (the status/list read):
 * an absent switch is INACTIVE, and if ANY switch read fails closed the whole
 * list is reported 'invalid'.  `null` ⇒ every switch is pristine/absent.
 */
export async function readKillSwitchRegistry(
  configStore: PwattConfigStore,
): Promise<KillSwitchRegistry | null | 'invalid'> {
  const switches = {} as Record<KillSwitchId, KillSwitchEntry>;
  let anyPresent = false;
  let latest = '';
  for (const id of KILL_SWITCH_IDS) {
    const entry = await readSwitchEntry(configStore, id);
    if (entry === 'invalid') return 'invalid';
    if (entry === null) {
      switches[id] = structuredClone(INACTIVE_ENTRY);
    } else {
      switches[id] = entry;
      anyPresent = true;
      if (entry.engaged_at !== null && entry.engaged_at > latest) latest = entry.engaged_at;
    }
  }
  if (!anyPresent) return null;
  return { switches, updated_at: latest || new Date(0).toISOString() };
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
  const entry = await readSwitchEntry(configStore, switchId);
  if (entry === null) return { engaged: false };
  if (entry === 'invalid') return { engaged: true, scope: 'unreadable_state' };

  if (entry.scopes.global) return { engaged: true, scope: 'global' };
  if (entry.scopes.regions.length > 0) {
    // Case-INSENSITIVE match: the resolver normalizes locale regions to
    // uppercase, but an operator may activate with a lowercase BCP-47 subtag
    // (`us`) — a case mismatch must not leave `US` users unblocked.
    const region = context.region?.toUpperCase() ?? null;
    const engaged = entry.scopes.regions.map((r) => r.toUpperCase());
    // Unknown region ⇒ treated as inside every engaged region scope.
    if (region === null || engaged.includes(region)) {
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
      code:
        | 'registry_unreadable'
        | 'empty_scopes'
        | 'not_engaged'
        | 'no_pending_request'
        | 'same_operator';
      message: string;
    };

/** Read ONE switch for an admin edit; INACTIVE when absent, 'invalid' fails closed. */
async function loadSwitch(
  deps: KillSwitchAdminDeps,
  switchId: KillSwitchId,
): Promise<KillSwitchEntry | 'invalid'> {
  const entry = await readSwitchEntry(deps.configStore, switchId);
  if (entry === 'invalid') return 'invalid';
  return entry ?? structuredClone(INACTIVE_ENTRY);
}

/** Persist ONE switch entry under its own key — no shared-registry rewrite. */
async function persistSwitch(
  deps: KillSwitchAdminDeps,
  switchId: KillSwitchId,
  entry: KillSwitchEntry,
): Promise<void> {
  await deps.configStore.set(switchConfigKey(switchId), entry);
}

/** True when the entry's scopes actually block SOME traffic (global/region/room). */
function hasActiveScope(scopes: KillSwitchScopes): boolean {
  return scopes.global || scopes.regions.length > 0 || scopes.room_ids.length > 0;
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
  // REJECT an empty-scope activation: `killSwitchDecision` treats
  // `{global:false, regions:[], room_ids:[]}` as INACTIVE, so persisting it would
  // record an `engaged_at` and return success while blocking NOTHING — an
  // incident operator would believe the surface is frozen when it is not.  A
  // malformed admin request / UI bug must fail loudly, not silently no-op
  // (WS-L.3.5f).
  if (!hasActiveScope(input.scopes)) {
    return {
      ok: false,
      code: 'empty_scopes',
      message: 'An activation must select at least one scope (global, a region, or a room).',
    };
  }
  const existing = await loadSwitch(deps, input.switchId);
  if (existing === 'invalid') {
    // A corrupt switch entry is already failing closed; refuse to overwrite it
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
  await persistSwitch(deps, input.switchId, entry);
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
  const entry = await loadSwitch(deps, input.switchId);
  if (entry === 'invalid') {
    return {
      ok: false,
      code: 'registry_unreadable',
      message: 'The stored kill-switch registry is unreadable (all switches fail closed).',
    };
  }
  if (!hasActiveScope(entry.scopes)) {
    return { ok: false, code: 'not_engaged', message: 'The switch is not engaged.' };
  }
  const updated: KillSwitchEntry = { ...entry, deactivation_requested_by: input.actorUserId };
  await persistSwitch(deps, input.switchId, updated);
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
  return { ok: true, entry: structuredClone(updated) };
}

/**
 * Step 2: a DIFFERENT operator confirms — only then does the switch release
 * (WS-L.3.5f: a single operator can never unilaterally disable a switch).
 */
export async function confirmKillSwitchDeactivation(
  deps: KillSwitchAdminDeps,
  input: { switchId: KillSwitchId; actorUserId: string; reason: string },
): Promise<KillSwitchAdminResult> {
  const entry = await loadSwitch(deps, input.switchId);
  if (entry === 'invalid') {
    return {
      ok: false,
      code: 'registry_unreadable',
      message: 'The stored kill-switch registry is unreadable (all switches fail closed).',
    };
  }
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
  await persistSwitch(deps, input.switchId, structuredClone(INACTIVE_ENTRY));
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
