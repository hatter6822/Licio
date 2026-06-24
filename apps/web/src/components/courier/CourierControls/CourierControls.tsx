// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4e — the §22.5 courier-controls UI (OFFLINE_SPEC §22.5, §26).  Exposes every
// required control — discovery on/off, advertising on/off, who-can-exchange, the sharing
// selection (rooms/priorities), the storage budget, the battery budget, and the
// public-content-only statement — and, CRITICALLY, renders the RADIO-METADATA DISCLOSURE
// that the user MUST acknowledge BEFORE the advertise/discover toggles can be enabled.
//
// HONEST COPY: the disclosure states exactly what a nearby radio reveals; it never claims
// the courier is "secure"/"private"/"anonymous"/"safe".  The advertise + discover toggles
// are DISABLED until the disclosure is acknowledged — a partially-built radio can never be
// turned on before the user has seen what it exposes.  This always-available surface
// mirrors the controls state locally (no `@licio/lcap` codec import), keeping it off the
// lazy bundle-codec chunk.

import { useCallback, useMemo, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import {
  COURIER_CHANNEL_INFO,
  type CourierChannel,
} from '../../../lcap/transports/courier-channels.js';
import {
  getCourierControls,
  getRadioDisclosureAcknowledged,
  setCourierControls,
  setRadioDisclosureAcknowledged,
} from '../../../lcap/transports/courier-controls-state.js';
import type {
  CourierExchangePeers,
  CourierRadioControls,
} from '../../../lcap/transports/courier-native.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Checkbox } from '../../ui/Checkbox/index.js';
import { Input } from '../../ui/Input/index.js';
import { Select } from '../../ui/Select/index.js';
import { Switch } from '../../ui/Switch/index.js';

const MIB = 1024 * 1024;

const PEER_OPTIONS: ReadonlyArray<{
  value: CourierExchangePeers;
  labelKey: string;
  label: string;
}> = [
  { value: 'anyone', labelKey: 'courier.peers.anyone', label: 'Anyone nearby' },
  { value: 'known_only', labelKey: 'courier.peers.known', label: 'Only devices I have allowed' },
  { value: 'none', labelKey: 'courier.peers.none', label: 'No one (radios stay idle)' },
];

const PRIORITY_OPTIONS: ReadonlyArray<{ value: '0' | '1' | '2' | '3' | '4'; label: string }> = [
  { value: '0', label: 'P0 — critical only' },
  { value: '1', label: 'P0–P1 — critical + high' },
  { value: '2', label: 'P0–P2 — through standard' },
  { value: '3', label: 'P0–P3' },
  { value: '4', label: 'All lanes' },
];

export interface CourierControlsProps {
  /** Notify a parent when the controls change (e.g. to re-evaluate the controller). */
  readonly onControlsChange?: (controls: CourierRadioControls) => void;
  /**
   * Notify a parent when the radio-metadata disclosure acknowledgment changes — so a
   * runtime driver (e.g. `CourierRunner`) can enable/disable Start and stop a running
   * courier fail-closed the moment the user revokes acknowledgment.
   */
  readonly onAcknowledgeChange?: (acknowledged: boolean) => void;
  readonly className?: string;
}

/**
 * The §22.5 courier controls.  Reads/writes the persisted controls + the disclosure
 * acknowledgment; the advertise/discover toggles are disabled until the disclosure is
 * acknowledged.
 */
export function CourierControls({
  onControlsChange,
  onAcknowledgeChange,
  className,
}: CourierControlsProps): React.ReactElement {
  const t = useT();
  const [controls, setControls] = useState<CourierRadioControls>(() => getCourierControls());
  const [acknowledged, setAcknowledged] = useState<boolean>(() => getRadioDisclosureAcknowledged());

  const update = useCallback(
    (next: CourierRadioControls) => {
      setCourierControls(next);
      setControls(next);
      onControlsChange?.(next);
    },
    [onControlsChange],
  );

  const acknowledge = useCallback(
    (value: boolean) => {
      setRadioDisclosureAcknowledged(value);
      setAcknowledged(value);
      onAcknowledgeChange?.(value);
      // Revoking the acknowledgment also turns the radios off (fail-closed).
      if (!value) {
        update({ ...controls, advertisingEnabled: false, discoveryEnabled: false });
      }
    },
    [controls, update, onAcknowledgeChange],
  );

  const storageBudgetMib = useMemo(
    () => Math.round((controls.storageBudgetBytes ?? 0) / MIB),
    [controls.storageBudgetBytes],
  );
  const batteryFloorPct = useMemo(
    () => Math.round((controls.batteryFloor ?? 0) * 100),
    [controls.batteryFloor],
  );

  const channels = Object.values(COURIER_CHANNEL_INFO);

  return (
    <section
      className={cn('flex flex-col gap-5', className)}
      aria-label={t('courier.title', 'Nearby courier')}
    >
      {/* The radio-metadata disclosure — rendered FIRST and required before the toggles. */}
      <div
        role="region"
        aria-label={t('courier.disclosure.heading', 'What a nearby radio reveals')}
        className="flex flex-col gap-2 rounded-lg bg-warning-soft p-3 text-warning-on-soft"
      >
        <Badge tone="warning">
          {t('courier.disclosure.heading', 'What a nearby radio reveals')}
        </Badge>
        <p className="text-sm">
          {t(
            'courier.disclosure.body',
            'Turning on the courier makes this device discoverable to other devices in radio range. This is not anonymity: a nearby device, or anyone scanning, can see that this device is sharing content and the device name you choose. The courier only ever carries PUBLIC content — it never shares private rooms or your attention data — and every received item is re-checked against its content signatures, so a radio peer cannot inject forged content. It is off in Stealth and Emergency modes.',
          )}
        </p>
        <ul
          className="flex flex-col gap-1"
          aria-label={t('courier.disclosure.channels', 'Per radio')}
        >
          {channels.map((info) => (
            <li key={info.channel} className="text-xs">
              <span className="font-medium">{channelLabel(info.channel, t)}</span>
              {info.verification === 'physical_only' ? (
                <Badge tone="neutral">{t('courier.channel.physicalOnly', 'cable only')}</Badge>
              ) : null}
              {': '}
              {t(`courier.channel.reveals.${info.channel}`, info.revealsSummary)}
            </li>
          ))}
        </ul>
        <Checkbox
          checked={acknowledged}
          onCheckedChange={acknowledge}
          label={t(
            'courier.disclosure.ack',
            'I understand what a nearby radio reveals and want to enable the courier.',
          )}
        />
      </div>

      {/* discovery / advertising on-off — disabled until the disclosure is acknowledged. */}
      <fieldset className="flex flex-col gap-3 border-0 p-0">
        <legend className="text-sm font-medium text-ink">
          {t('courier.radios.legend', 'Radios')}
        </legend>
        <Switch
          label={t('courier.advertise.label', 'Advertise this device as a courier')}
          description={
            acknowledged
              ? t('courier.advertise.desc', 'Let nearby devices find and connect to this one.')
              : t('courier.advertise.locked', 'Acknowledge the disclosure above first.')
          }
          checked={controls.advertisingEnabled}
          disabled={!acknowledged}
          onCheckedChange={(checked) => update({ ...controls, advertisingEnabled: checked })}
        />
        <Switch
          label={t('courier.discover.label', 'Discover nearby couriers')}
          description={
            acknowledged
              ? t('courier.discover.desc', 'Find and connect to nearby devices sharing content.')
              : t('courier.discover.locked', 'Acknowledge the disclosure above first.')
          }
          checked={controls.discoveryEnabled}
          disabled={!acknowledged}
          onCheckedChange={(checked) => update({ ...controls, discoveryEnabled: checked })}
        />
      </fieldset>

      {/* who-can-exchange */}
      <Select
        label={t('courier.peers.label', 'Who can exchange with this device')}
        value={controls.exchangePeers ?? 'anyone'}
        onValueChange={(value) =>
          update({ ...controls, exchangePeers: value as CourierExchangePeers })
        }
        options={PEER_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey, o.label) }))}
      />

      {/* sharing selection — which priorities are offered */}
      <Select
        label={t('courier.priority.label', 'Which content priorities to share')}
        value={String(controls.sharing?.maxPriorityClass ?? 4)}
        onValueChange={(value) =>
          update({
            ...controls,
            sharing: {
              roomHashAllowlist: controls.sharing?.roomHashAllowlist ?? [],
              maxPriorityClass: Number(value) as 0 | 1 | 2 | 3 | 4,
            },
          })
        }
        options={PRIORITY_OPTIONS.map((o) => ({
          value: o.value,
          label: t(`courier.priority.${o.value}`, o.label),
        }))}
      />

      {/* storage budget */}
      <Input
        type="number"
        min={0}
        label={t('courier.storage.label', 'Storage budget to share (MiB, 0 = unlimited)')}
        value={String(storageBudgetMib)}
        onChange={(e) => {
          const mib = Math.max(0, Math.floor(Number(e.target.value) || 0));
          update({ ...controls, storageBudgetBytes: mib * MIB });
        }}
      />

      {/* battery budget */}
      <Input
        type="number"
        min={0}
        max={100}
        label={t(
          'courier.battery.label',
          'Do not advertise below this battery level (%, 0 = no floor)',
        )}
        value={String(batteryFloorPct)}
        onChange={(e) => {
          const pct = Math.min(100, Math.max(0, Math.floor(Number(e.target.value) || 0)));
          update({ ...controls, batteryFloor: pct / 100 });
        }}
      />

      <p className="text-xs text-ink-muted">
        {t(
          'courier.publicOnly',
          'The courier carries public content only. Private rooms are never shared over a radio.',
        )}
      </p>
    </section>
  );
}

function channelLabel(channel: CourierChannel, t: ReturnType<typeof useT>): string {
  switch (channel) {
    case 'nearby':
      return t('courier.channel.nearby', 'Nearby Connections');
    case 'wifiDirect':
      return t('courier.channel.wifiDirect', 'Wi-Fi Direct');
    case 'bluetooth':
      return t('courier.channel.bluetooth', 'Bluetooth');
    case 'usb':
      return t('courier.channel.usb', 'USB');
  }
}
