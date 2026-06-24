// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the safety-number (SAS) verification panel (PRIVATE_SPEC §15.5 /
// §20.4).  For a chosen other member's DEVICE it computes the symmetric safety
// number from BOTH devices' LONG-TERM signing keys + the room-id commitment
// (`PrivateRoomSession.computeMemberSafetyNumber`, which delegates to the shipped
// `computeSafetyNumber` crypto — never reimplemented here) and renders the 12
// five-digit groups for out-of-band comparison.  A per-device "mark verified"
// toggle persists LOCALLY (this device only) — it is never sent anywhere and
// confers no authority; it is a reminder that the user compared the number over a
// TRUSTED channel.  The copy makes the trusted-channel requirement explicit.

import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import type { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';
import { Checkbox } from '../../ui/Checkbox/index.js';

/** A device the local member can verify (id + the owning member's render label). */
export interface VerifiableDevice {
  readonly deviceId: string;
  readonly memberId: string;
  readonly displayName?: string;
}

export interface SafetyNumberPanelProps {
  session: PrivateRoomSession;
  /** The other members' devices to choose from (excludes the local device). */
  devices: readonly VerifiableDevice[];
}

/** The localStorage key for the locally-recorded verified devices of a room. */
function verifiedKey(roomId: string): string {
  return `licio.private-p2p.verified-devices.${roomId}`;
}

function readVerified(roomId: string): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(verifiedKey(roomId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    // Corrupt local state must never brick the panel — treat as nothing verified.
  }
  return new Set();
}

function writeVerified(roomId: string, set: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(verifiedKey(roomId), JSON.stringify([...set]));
  } catch {
    // Storage unavailable (private mode / quota): availability over persistence.
  }
}

function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

export function SafetyNumberPanel({
  session,
  devices,
}: SafetyNumberPanelProps): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [groups, setGroups] = useState<readonly string[] | null>(null);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Set<string>>(() => readVerified(session.roomId));

  const compute = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      setGroups(null);
      setError(null);
      setComputing(true);
      void session
        .computeMemberSafetyNumber(deviceId)
        .then((sas) => {
          if (sas === null) {
            setError(t('privateRoom.sas.unknownDevice', 'That device is not in this room.'));
          } else {
            setGroups(sas.groups);
          }
        })
        .catch(() => {
          setError(t('privateRoom.sas.error', 'Could not compute the safety number.'));
        })
        .finally(() => setComputing(false));
    },
    [session, t],
  );

  useEffect(() => {
    setVerified(readVerified(session.roomId));
  }, [session.roomId]);

  function toggleVerified(deviceId: string, isVerified: boolean): void {
    setVerified((prev) => {
      const next = new Set(prev);
      if (isVerified) next.add(deviceId);
      else next.delete(deviceId);
      writeVerified(session.roomId, next);
      return next;
    });
  }

  return (
    <Card>
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h3 id={headingId} className="font-semibold text-sm">
          {t('privateRoom.sas.title', 'Verify a member’s device')}
        </h3>
        <p className="neu-inset rounded-lg p-3 text-ink-muted text-sm" role="note">
          {t(
            'privateRoom.sas.note',
            'Compare this number with the other person over a channel you already trust (in person, or a call you recognise). If the numbers match, no one is intercepting your connection. Marking a device verified only reminds you here — it is never sent anywhere.',
          )}
        </p>

        {devices.length === 0 ? (
          <p className="text-ink-muted text-sm">
            {t('privateRoom.sas.noOthers', 'No other devices to verify yet.')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((device) => (
              <li key={device.deviceId} className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={selectedDeviceId === device.deviceId ? 'primary' : 'secondary'}
                  onClick={() => compute(device.deviceId)}
                  disabled={computing}
                >
                  {device.displayName !== undefined && device.displayName.length > 0
                    ? device.displayName
                    : shortId(device.memberId)}
                  <span className="ml-1 font-mono text-xs">({shortId(device.deviceId)})</span>
                </Button>
                <Checkbox
                  label={t('privateRoom.sas.markVerified', 'Verified out-of-band')}
                  checked={verified.has(device.deviceId)}
                  onCheckedChange={(checked) => toggleVerified(device.deviceId, checked)}
                />
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p className="text-error-on-soft text-sm" role="alert">
            {error}
          </p>
        ) : null}

        {groups !== null && selectedDeviceId !== null ? (
          <div>
            <p className="mb-1 text-ink-muted text-xs">
              {t('privateRoom.sas.compareLabel', 'Safety number for {device}', {
                device: shortId(selectedDeviceId),
              })}
            </p>
            <div
              role="group"
              className="grid grid-cols-3 gap-2 font-mono text-base sm:grid-cols-4"
              aria-label={t('privateRoom.sas.value', 'Safety number digits')}
            >
              {groups.map((group, index) => (
                // Fixed-position display chunks of one number; a chunk value can
                // repeat, so the position index disambiguates the key.
                <span
                  key={`${index}-${group}`}
                  className="neu-pressed rounded px-2 py-1 text-center"
                >
                  {group}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </Card>
  );
}
