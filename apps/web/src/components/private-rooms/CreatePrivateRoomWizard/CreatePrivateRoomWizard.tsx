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
import { useEffect, useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ApiClientError } from '../../../lib/api.js';
import {
  createPrivateRoomStub,
  deletePrivateRoomStub,
  findMyPrivateRoomStub,
} from '../../../lib/private-rooms-api.js';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { useAuthStore } from '../../../stores/auth.js';
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

/** The one-line label for each mode, keyed so the option list can be built from
 *  whichever subset the caller is actually able to choose from. */
const DIRECTORY_LABELS: Record<DirectoryChoice, (t: ReturnType<typeof useT>) => string> = {
  detached: (t) =>
    t(
      'privateRoom.create.directory.detached',
      'Nobody — Licio keeps no record of it (invite only)',
    ),
  unlisted: (t) =>
    t(
      'privateRoom.create.directory.unlisted',
      'People you invite — Licio stores a bootstrap record, no name',
    ),
  listed: (t) =>
    t(
      'privateRoom.create.directory.listed',
      'Anyone browsing Licio — the room is named in the public directory',
    ),
};

export function CreatePrivateRoomWizard({
  onCreated,
}: CreatePrivateRoomWizardProps): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [name, setName] = useState('');
  const [roomType, setRoomType] = useState<RoomType>('global_topic');
  // The §4.2 default needs an ACCOUNT to be honest.
  //
  // `/private` is deliberately reachable signed out — a P2P room is hosted on
  // this device and needs no Licio identity — but registering a directory stub
  // is an authenticated write. Defaulting a signed-out visitor to `unlisted`
  // promised a bootstrap record in the copy, then produced a 401 and a silently
  // detached room. §4.2's default governs what a room CAN be, and for a caller
  // who cannot register one, `detached` is not a weaker choice, it is the only
  // true one.
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const [directory, setDirectory] = useState<DirectoryChoice>(
    signedIn ? DEFAULT_P2P_DIRECTORY_MODE : 'detached',
  );
  // …and FOLLOW the session, not just sample it at mount. A session can expire
  // or another tab can sign out between choosing `listed` and submitting, and
  // the select then showed one option while holding a different, stale value —
  // so the room was created and the stub POST 401'd, which is the bug the
  // account-aware default was meant to remove.
  useEffect(() => {
    if (!signedIn) setDirectory('detached');
  }, [signedIn]);
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
        // A failure ANYWHERE in here can leave a server record the client did
        // not record the id of: the local write can fail after a successful
        // POST (quota, a private-mode eviction), and the POST's response can be
        // lost after it commits. Both used to strand a record its own creator
        // could never address — publicly enumerable, if it was listed. The
        // catch reconciles against the server instead of rolling back from what
        // this client happens to be holding.
        // INSIDE the try, because the room already exists by now.
        //
        // Deriving and signing the stub body can fail — key derivation, a
        // signature — and hoisting it out to give the catch a `roomPublicKey`
        // put that failure in the OUTER handler, which reports "could not create
        // the room on this device" and leaves the form retryable. The room WAS
        // created; a user retrying makes a second one. The directory step is
        // best-effort by design, and every part of it belongs on that path.
        //
        // The signing key is read separately, before the try, so the catch can
        // still identify OUR record on the server — that read cannot fail.
        const roomPublicKey = session.signingPublicKey;
        let created: Awaited<ReturnType<typeof createPrivateRoomStub>> | null = null;
        /** Did a request actually go out? Nothing to reconcile if it did not. */
        let posted = false;
        try {
          const payload = await session.directoryStubPayload();
          posted = true;
          created = await createPrivateRoomStub({
            directoryMode: directory,
            // Display metadata is `listed`-only — the server REFUSES it on an
            // unlisted room rather than dropping it silently, so send it only
            // where it belongs.
            ...(directory === 'listed' ? { displayName: name.trim() } : {}),
            rendezvousPolicy: 'licio_blind',
            signedStub: payload.signedStub,
            stubSignature: payload.stubSignature,
            bootstrapBlindId: payload.bootstrapBlindId,
          });
          // PERSIST the server-minted id. It is the only handle for every later
          // bootstrap, patch, delist and delete, and no endpoint lists an
          // account's stubs — dropping it here would create a record nobody
          // could ever reach or remove.
          await session.attachDirectoryStub({
            roomServerId: created.room_server_id,
            // Stored, not re-derived later: it comes from the EPOCH-0 rendezvous
            // key, so a member admitted at a later epoch could never compute it —
            // this copy is what a sealed invite hands on.
            bootstrapBlindId: payload.bootstrapBlindId,
          });
        } catch (error) {
          directoryFailed = true;
          setDirectoryWarning(
            t(
              'privateRoom.create.directoryFailed',
              'The room was created on this device, but Licio could not save its directory record. Share an invite directly, or try listing it again later.',
            ),
          );
          // RECONCILE against the server, but only when the request PLAUSIBLY
          // reached it.
          //
          // Three failures look alike from here and are not: the local write
          // failing after a successful POST (a record exists, id known), the
          // POST committing and its response being lost (a record exists, id
          // unknown), and the POST never leaving the machine (no record). The
          // last is the common offline case, and a follow-up read cannot answer
          // there either — warning about a record that does not exist, on the
          // one connection that cannot check, is noise.
          //
          // A response-bearing 4xx is the server REFUSING: nothing committed,
          // nothing to reconcile. EVERYTHING ELSE reconciles — including the
          // bare transport failure, which is the ambiguous case the owner
          // lookup was added for: the request may have committed and its
          // response been lost, and skipping the check there left exactly the
          // orphan this whole path exists to prevent.
          const status = error instanceof ApiClientError ? error.status : undefined;
          const serverRefused = status !== undefined && status >= 400 && status < 500;
          // Whether we KNOW something is out there, which decides how loudly a
          // failed reconciliation speaks (see the catch below).
          const knownCommitted = created !== null || (status !== undefined && status >= 500);
          // Nothing was sent if the body could not be built, so there is no
          // record anywhere to reconcile against.
          if (posted && !serverRefused) {
            try {
              // The room's founder signing key identifies OUR record: the local
              // session knows it, and it is what the room signed. This is why
              // the owner lookup exists — without it, a lost response left a
              // record nobody could ever address.
              const ours = await findMyPrivateRoomStub({ roomPublicKey });
              if (ours !== null) await deletePrivateRoomStub(ours.room_server_id);
            } catch {
              // The reconcile read failed too. Escalate the copy only when a
              // record is KNOWN to exist: if the create was a bare transport
              // failure and this read is also unreachable, the device is simply
              // offline and the POST most likely never landed — warning about a
              // record that probably does not exist, on the one connection that
              // cannot check, teaches people to ignore the warning.
              if (knownCommitted) {
                setDirectoryWarning(
                  t(
                    'privateRoom.create.directoryUnreconciled',
                    'The room was created on this device, but Licio could not confirm whether a directory record was saved for it. Open this room’s settings later to check and remove it if one is there.',
                  ),
                );
              }
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
        // A signed-out visitor cannot register a stub at all, so the two modes
        // that need one are not offered rather than offered-and-failing.
        options={(signedIn ? DIRECTORY_CHOICES : (['detached'] as const)).map((value) => ({
          value,
          label: DIRECTORY_LABELS[value](t),
        }))}
      />
      {signedIn ? null : (
        <p className="text-ink-muted text-xs" role="note">
          {t(
            'privateRoom.create.directorySignedOut',
            'Sign in to have Licio store a bootstrap record for this room. Without one the room still works — you share access yourself, by QR, file or message.',
          )}
        </p>
      )}
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
