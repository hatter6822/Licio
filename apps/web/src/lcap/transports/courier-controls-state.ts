// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4e — the persisted §22.5 courier radio controls.  Like `mode-state.ts`, this is
// a plain zod-validated persisted module (NOT a Zustand store, so the documented client
// store-count is unchanged): the controls UI writes it, and the courier controller reads
// it before starting the radios.  The radios are OFF by default; an invalid persisted
// slice falls back to the conservative default (everything off).
//
// No radio/peer identifier ever reaches an LCAP schema — the persisted controls are a
// LOCAL device preference (room hashes are opaque; endpoint ids are NEVER persisted here,
// only chosen live).  This module imports only local pure code; it stays off the lazy
// codec chunk apps/web loads `@licio/lcap` into.

import { z } from 'zod';
import { loadPersisted, type PersistConfig, savePersisted } from '../../stores/persist.js';
import { COURIER_CHANNELS, type CourierChannel } from './courier-channels.js';
import {
  type CourierExchangePeers,
  type CourierRadioControls,
  DEFAULT_COURIER_CONTROLS,
} from './courier-native.js';

const exchangePeersSchema = z.enum(['anyone', 'known_only', 'none']);
// Single-sourced from the COURIER_CHANNELS SSOT (PUB-COURIER-5): the persisted-controls validator
// and the controller seam now share ONE channel set, so a new radio cannot silently diverge.
const channelSchema = z.enum(COURIER_CHANNELS as [CourierChannel, ...CourierChannel[]]);

const courierControlsSchema = z
  .object({
    advertisingEnabled: z.boolean(),
    discoveryEnabled: z.boolean(),
    enabledChannels: z.array(channelSchema).max(8),
    exchangePeers: exchangePeersSchema,
    allowedEndpointIds: z.array(z.string().min(1).max(256)).max(256),
    sharing: z.object({
      roomHashAllowlist: z.array(z.string().min(1).max(256)).max(256),
      maxPriorityClass: z.union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
      ]),
    }),
    storageBudgetBytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024 * 1024 * 1024),
    batteryFloor: z.number().min(0).max(1),
  })
  .strict();

type PersistedCourierControls = z.infer<typeof courierControlsSchema>;

const PERSIST: PersistConfig<PersistedCourierControls> = {
  key: 'lcap-courier-controls',
  schema: courierControlsSchema,
  // v2 adds `enabledChannels` (WS-R.15.4d); a v1 slice is discarded → conservative default.
  version: 2,
};

const DEFAULT_CHANNELS = ['nearby'] as const;

/** The canonical default (everything off, Nearby-only) as the persisted shape. */
const DEFAULT_PERSISTED: PersistedCourierControls = {
  advertisingEnabled: DEFAULT_COURIER_CONTROLS.advertisingEnabled,
  discoveryEnabled: DEFAULT_COURIER_CONTROLS.discoveryEnabled,
  enabledChannels: [...DEFAULT_CHANNELS],
  exchangePeers: DEFAULT_COURIER_CONTROLS.exchangePeers ?? 'anyone',
  allowedEndpointIds: [...(DEFAULT_COURIER_CONTROLS.allowedEndpointIds ?? [])],
  sharing: {
    roomHashAllowlist: [...(DEFAULT_COURIER_CONTROLS.sharing?.roomHashAllowlist ?? [])],
    maxPriorityClass: DEFAULT_COURIER_CONTROLS.sharing?.maxPriorityClass ?? 4,
  },
  storageBudgetBytes: DEFAULT_COURIER_CONTROLS.storageBudgetBytes ?? 0,
  batteryFloor: DEFAULT_COURIER_CONTROLS.batteryFloor ?? 0,
};

function normalizeChannels(
  channels: readonly string[] | undefined,
): PersistedCourierControls['enabledChannels'] {
  const parsed = z
    .array(channelSchema)
    .max(8)
    .safeParse(channels ?? []);
  const list = parsed.success && parsed.data.length > 0 ? parsed.data : [...DEFAULT_CHANNELS];
  return list;
}

/** The current persisted §22.5 controls (the conservative default on any invalid slice). */
export function getCourierControls(): CourierRadioControls {
  const loaded = loadPersisted(PERSIST) ?? DEFAULT_PERSISTED;
  return {
    advertisingEnabled: loaded.advertisingEnabled,
    discoveryEnabled: loaded.discoveryEnabled,
    enabledChannels: loaded.enabledChannels,
    exchangePeers: loaded.exchangePeers as CourierExchangePeers,
    allowedEndpointIds: loaded.allowedEndpointIds,
    sharing: loaded.sharing,
    storageBudgetBytes: loaded.storageBudgetBytes,
    batteryFloor: loaded.batteryFloor,
  };
}

/** Persist updated §22.5 controls (the controls UI calls this). */
export function setCourierControls(controls: CourierRadioControls): void {
  savePersisted(PERSIST, {
    advertisingEnabled: controls.advertisingEnabled,
    discoveryEnabled: controls.discoveryEnabled,
    enabledChannels: normalizeChannels(controls.enabledChannels),
    exchangePeers: controls.exchangePeers ?? 'anyone',
    allowedEndpointIds: [...(controls.allowedEndpointIds ?? [])],
    sharing: {
      roomHashAllowlist: [...(controls.sharing?.roomHashAllowlist ?? [])],
      maxPriorityClass: controls.sharing?.maxPriorityClass ?? 4,
    },
    storageBudgetBytes: controls.storageBudgetBytes ?? 0,
    batteryFloor: controls.batteryFloor ?? 0,
  });
}

/**
 * Whether the user has acknowledged the §22.5 radio-metadata disclosure.  The controls UI
 * MUST gate the advertise/discover toggles on this: advertising/discovery cannot be
 * enabled until the user has been shown — and accepted — what a nearby radio reveals.
 * Persisted separately so revoking acknowledgment forces the disclosure to reappear.
 */
const ackSchema = z.object({ acknowledged: z.boolean() }).strict();
const ACK_PERSIST: PersistConfig<z.infer<typeof ackSchema>> = {
  key: 'lcap-courier-radio-disclosure-ack',
  schema: ackSchema,
  version: 1,
};

export function getRadioDisclosureAcknowledged(): boolean {
  return loadPersisted(ACK_PERSIST)?.acknowledged ?? false;
}

export function setRadioDisclosureAcknowledged(acknowledged: boolean): void {
  savePersisted(ACK_PERSIST, { acknowledged });
}
