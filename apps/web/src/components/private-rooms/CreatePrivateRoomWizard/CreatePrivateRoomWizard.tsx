// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the private-room creation wizard.  It renders the §20.1 room-class
// label, the §6/§20.2 honest-limits DISCLOSURE, and the five mandatory
// acknowledgments (all from the `@licio/shared` SSOT — never re-worded here), and
// BLOCKS creation until every acknowledgment is checked (and a name is given).
// On submit it calls `PrivateRoomSession.create`, which lazily loads the
// code-split crypto/protocol core (so this route never pulls it into the initial
// bundle).  The copy is the prohibited-language-linted SSOT, so the UI can never
// promise "secure"/"deleted everywhere".

import {
  PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS,
  PRIVATE_ROOM_CREATION_DISCLOSURE,
  ROOM_CLASS_UI_LABELS,
  ROOM_TYPES,
  type RoomType,
} from '@licio/shared';
import { useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { Button } from '../../ui/Button/index.js';
import { Checkbox } from '../../ui/Checkbox/index.js';
import { Input } from '../../ui/Input/index.js';
import { Select } from '../../ui/Select/index.js';

export interface CreatePrivateRoomWizardProps {
  onCreated?: (roomId: string) => void;
}

export function CreatePrivateRoomWizard({
  onCreated,
}: CreatePrivateRoomWizardProps): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [name, setName] = useState('');
  const [roomType, setRoomType] = useState<RoomType>('global_topic');
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allAcked = PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS.every((a) => acked[a.id] === true);
  const canCreate = allAcked && name.trim().length > 0 && !creating;

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const session = await PrivateRoomSession.create({
        roomName: name.trim(),
        roomType,
        founderMemberId: globalThis.crypto.randomUUID(),
        founderDeviceId: globalThis.crypto.randomUUID(),
      });
      onCreated?.(session.roomId);
    } catch {
      setError(t('privateRoom.create.error', 'Could not create the room on this device.'));
      setCreating(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby={headingId}
      className="flex flex-col gap-4"
    >
      <h2 id={headingId} className="font-semibold text-lg">
        {t('privateRoom.create.title', 'Create a {label}', {
          label: ROOM_CLASS_UI_LABELS.private_p2p,
        })}
      </h2>

      {/* The §20.2 blocking disclosure — verbatim from the SSOT. */}
      <p className="neu-inset rounded-lg p-3 text-sm text-soft-foreground" role="note">
        {PRIVATE_ROOM_CREATION_DISCLOSURE}
      </p>

      <Input
        label={t('privateRoom.create.name', 'Room name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <Select
        label={t('privateRoom.create.type', 'Room type')}
        value={roomType}
        onValueChange={(v) => setRoomType(v as RoomType)}
        options={ROOM_TYPES.map((type) => ({ value: type, label: type.replace(/_/g, ' ') }))}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-sm">
          {t('privateRoom.create.ackLegend', 'Please acknowledge each point to continue')}
        </legend>
        {PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS.map((ack) => (
          <Checkbox
            key={ack.id}
            label={ack.label}
            checked={acked[ack.id] === true}
            onCheckedChange={(checked) => setAcked((prev) => ({ ...prev, [ack.id]: checked }))}
          />
        ))}
      </fieldset>

      {error ? (
        <p className="text-error-on-soft text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={!canCreate}>
        {creating
          ? t('privateRoom.create.creating', 'Creating…')
          : t('privateRoom.create.submit', 'Create private room')}
      </Button>
    </form>
  );
}
