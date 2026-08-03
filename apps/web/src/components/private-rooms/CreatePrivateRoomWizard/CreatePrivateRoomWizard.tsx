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
  DEFAULT_P2P_DIRECTORY_MODE,
  PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS,
  PRIVATE_ROOM_CREATION_DISCLOSURE,
  ROOM_CLASS_UI_LABELS,
  ROOM_TYPES,
  type RoomType,
} from '@licio/shared';
import { useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { createPrivateRoomStub, deletePrivateRoomStub } from '../../../lib/private-rooms-api.js';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { Button } from '../../ui/Button/index.js';
import { Checkbox } from '../../ui/Checkbox/index.js';
import { Input } from '../../ui/Input/index.js';
import { Select } from '../../ui/Select/index.js';

export interface CreatePrivateRoomWizardProps {
  onCreated?: (roomId: string) => void;
}

/** §4.2 — how discoverable the room's EXISTENCE is, chosen at creation.
 *
 *  The default is NOT a UI preference to be argued from first principles: §4.2
 *  says it MUST be `unlisted`, and `DEFAULT_P2P_DIRECTORY_MODE` is where that
 *  requirement lives, so this reads it rather than restating it. Defaulting to
 *  `detached` (the reasoning being "it leaks nothing") inverted the rule — it
 *  is the mode with no server record at all, so a room created under it can
 *  only ever be joined by manual QR/file exchange, and most users would have
 *  discovered that after the fact. `unlisted` leaks an opaque stub and nothing
 *  else, which is what makes an invite link work.
 *
 *  Ordered least-to-most disclosure so the list still reads as a privacy
 *  ladder; the default is selected, not first. */
const DIRECTORY_CHOICES = ['detached', 'unlisted', 'listed'] as const;
type DirectoryChoice = (typeof DIRECTORY_CHOICES)[number];

export function CreatePrivateRoomWizard({
  onCreated,
}: CreatePrivateRoomWizardProps): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [name, setName] = useState('');
  const [roomType, setRoomType] = useState<RoomType>('global_topic');
  const [directory, setDirectory] = useState<DirectoryChoice>(DEFAULT_P2P_DIRECTORY_MODE);
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directoryWarning, setDirectoryWarning] = useState<string | null>(null);
  /** Set when the room was created but its directory record was not, so the
   *  wizard can stay open to report it and still let the user continue. */
  const [createdRoomId, setCreatedRoomId] = useState<string | null>(null);

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
      // The room exists on this device the moment `create` resolves.  The
      // directory stub is a SEPARATE, optional, best-effort step (§21.1): if it
      // fails, the room is still perfectly usable through out-of-band invites,
      // so a network error here must not read as "creation failed" and must not
      // discard the room the user just made.
      let directoryFailed = false;
      if (directory !== 'detached') {
        // TWO steps, TWO catches. Sharing one was a leak: if the POST succeeded
        // and the local write then failed (quota, a private-mode eviction), the
        // single catch discarded `room_server_id` — and that id is the ONLY
        // handle for delist and delete, with no endpoint that lists an account's
        // stubs. The server record would survive, publicly enumerable for a
        // listed room, unreachable by the person who created it. So the local
        // failure ROLLS THE SERVER BACK rather than reporting the same warning as
        // a network failure that wrote nothing.
        let created: Awaited<ReturnType<typeof createPrivateRoomStub>> | null = null;
        try {
          const payload = await session.directoryStubPayload();
          created = await createPrivateRoomStub({
            directoryMode: directory,
            // Display metadata is `listed`-only — the server REFUSES it on an
            // unlisted room rather than dropping it silently, so send it only
            // where it belongs.
            ...(directory === 'listed' ? { displayName: name.trim() } : {}),
            roomPublicKey: payload.roomPublicKey,
            manifestKeyCommitment: payload.manifestKeyCommitment,
            rendezvousPolicy: 'licio_blind',
            signedStub: payload.signedStub,
            stubSignature: payload.stubSignature,
          });
          // PERSIST the server-minted id. It is the only handle for every later
          // bootstrap, patch, delist and delete, and no endpoint lists an
          // account's stubs — dropping it here would create a record nobody
          // could ever reach or remove.
          await session.attachDirectoryStub({
            roomServerId: created.room_server_id,
            stubId: created.stub_id,
            directoryMode: directory,
            // Stored, not re-derived later: it comes from the EPOCH-0 rendezvous
            // key, so a member admitted at a later epoch could never compute it —
            // this copy is what the join grant hands on.
            bootstrapBlindId: payload.bootstrapBlindId,
          });
        } catch {
          directoryFailed = true;
          const orphan = created;
          setDirectoryWarning(
            t(
              'privateRoom.create.directoryFailed',
              'The room was created on this device, but Licio could not save its directory record. Share an invite directly, or try listing it again later.',
            ),
          );
          if (orphan !== null) {
            try {
              await deletePrivateRoomStub(orphan.room_server_id);
            } catch {
              // The rollback itself failed, so a record this device can no longer
              // address does exist. Say so with the id, which is now the only way
              // back to it — silence here is what would make it unmanageable.
              setDirectoryWarning(
                t(
                  'privateRoom.create.directoryOrphan',
                  'The room was created on this device, but Licio saved a directory record this device could not keep track of, and could not remove it either. Its id is {id} — keep it if you want support to remove the record later.',
                  { id: orphan.room_server_id },
                ),
              );
            }
          }
        }
      }
      // HOLD the wizard open on a directory failure. The parent's `onCreated`
      // closes and navigates away, which would unmount this component before
      // the warning above ever painted — the user would land in the room
      // believing it was listed, and only discover otherwise when an invitee
      // could not resolve it. The room itself is already created and safe, so
      // this is a notice to acknowledge, not an error to retry.
      if (directoryFailed) {
        setCreating(false);
        setCreatedRoomId(session.roomId);
        return;
      }
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
      <p className="neu-inset rounded-lg p-3 text-sm text-ink-muted" role="note">
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

      <Select
        label={t('privateRoom.create.directory', 'Who can find this room')}
        value={directory}
        onValueChange={(v) => setDirectory(v as DirectoryChoice)}
        options={[
          {
            value: 'detached',
            label: t(
              'privateRoom.create.directory.detached',
              'Nobody — Licio keeps no record of it (invite only)',
            ),
          },
          {
            value: 'unlisted',
            label: t(
              'privateRoom.create.directory.unlisted',
              'People you invite — Licio stores a bootstrap record, no name',
            ),
          },
          {
            value: 'listed',
            label: t(
              'privateRoom.create.directory.listed',
              'Anyone browsing Licio — the room is named in the public directory',
            ),
          },
        ]}
      />
      {/* The honest limit of each choice, stated where the choice is made.  The
          room's CONTENT is end-to-end encrypted either way; what varies is how
          much the server knows the room EXISTS. */}
      <p className="text-ink-muted text-xs" role="note">
        {directory === 'detached'
          ? t(
              'privateRoom.create.directory.detachedNote',
              'Nothing about this room reaches Licio. You share access yourself, and if every member loses their keys it cannot be recovered.',
            )
          : directory === 'unlisted'
            ? t(
                'privateRoom.create.directory.unlistedNote',
                'Licio stores commitments and a bootstrap pointer — no name, no members, no messages. Only someone holding your invite can resolve it.',
              )
            : t(
                'privateRoom.create.directory.listedNote',
                'Licio stores the room name and description and shows them in a public directory anyone can browse — not only people you send the link to. Messages and members stay end-to-end encrypted, and joining still needs an invite from a member.',
              )}
      </p>

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

      {/* The directory step is best-effort: the room already exists locally, so
          this is a WARNING, not the creation error above — and it comes with the
          way forward, since the wizard deliberately stayed open to show it. */}
      {directoryWarning ? (
        <div className="flex flex-col gap-2">
          <p className="text-warning-on-soft text-sm" role="alert">
            {directoryWarning}
          </p>
          {createdRoomId !== null ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => onCreated?.(createdRoomId)}
              className="self-start"
            >
              {t('privateRoom.create.continueAnyway', 'Open the room anyway')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {createdRoomId === null ? (
        <Button type="submit" variant="primary" disabled={!canCreate}>
          {creating
            ? t('privateRoom.create.creating', 'Creating…')
            : t('privateRoom.create.submit', 'Create private room')}
        </Button>
      ) : null}
    </form>
  );
}
