// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 / PRIVATE_SPEC §21.2–§21.4 — what Licio publishes about this room,
// and the controls for changing it.
//
// This is the surface the §21.1/§21.3/§21.4 client calls existed for.  Without
// it the directory record was write-once at creation: a member could see the
// room was registered and had no way to read what the server actually serves,
// refresh the manifest commitment a bootstrapping peer verifies against, stop
// advertising a listed name, remove the record — or, once it was gone, ever have
// another, since REGISTRATION lived only inside the creation wizard.  That last
// gap is why the panel renders for a room with no record at all rather than
// returning null: a `detached` room, or one whose record was removed, is exactly
// the case with something to offer.
//
// It resolves the record through the STORED capability (`room_server_id` +
// `bootstrap_blind_id`, carried through the §12.3 join grant), which is the only
// way a non-founder member can read it at all — `bootstrap_blind_id` derives
// from the epoch-0 rendezvous key that a later member never held.
//
// Two honesty rules the copy enforces, both from §21.4:
//
//   • DELIST stops the room advertising itself.  The bootstrap record survives,
//     so members holding the token still resolve it — the button must not
//     promise removal.
//   • DELETE removes LICIO'S RECORD, never the room.  Member devices keep every
//     byte, because the server never held any.  The confirmation reads back the
//     server's own wording rather than inventing softer or harsher copy.

import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ApiClientError } from '../../../lib/api.js';
import {
  type BootstrapStub,
  createPrivateRoomStub,
  deletePrivateRoomStub,
  delistPrivateRoomStub,
  fetchPrivateRoomBootstrap,
  findMyPrivateRoomStub,
  updatePrivateRoomStub,
} from '../../../lib/private-rooms-api.js';
import type { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { useAuthStore } from '../../../stores/auth.js';
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';
import { Checkbox } from '../../ui/Checkbox/index.js';
import { Input } from '../../ui/Input/index.js';

export interface DirectoryRecordPanelProps {
  session: PrivateRoomSession;
}

type Action = 'refresh' | 'push' | 'delist' | 'remove' | 'register' | 'display' | 'forget' | null;

/** What the server currently holds for this room, as far as this panel knows. */
type RecordState =
  | { kind: 'reading' }
  | { kind: 'present'; record: BootstrapStub }
  /** No record — never registered, or one this device's handle outlived. */
  | { kind: 'absent' }
  /** The read failed for a reason that is NOT "there is nothing there". */
  | { kind: 'unreadable' }
  /** A record came back that this ROOM did not sign. */
  | { kind: 'unverified' };

export function DirectoryRecordPanel({
  session,
}: DirectoryRecordPanelProps): React.ReactElement | null {
  const t = useT();
  const headingId = useId();
  const stub = session.directoryStub?.capability;
  // Ownership is resolved against the CURRENT ACCOUNT, by asking the server
  // which records it owns.
  //
  // `registeredHere` was the second wrong proxy in a row. Room role was wrong
  // because the endpoints authorize by account; the persisted flag was wrong
  // because it records this DEVICE's history — private-room sessions survive a
  // logout, so another account signing in on the same device inherits it, while
  // the owning account opening the room through a grant on a second device does
  // not. Only the server knows, and it now says: `GET /v1/private-rooms/mine`.
  const [owned, setOwned] = useState(false);
  const [state, setState] = useState<RecordState>({ kind: 'reading' });
  const [removed, setRemoved] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action>(null);
  /** The §21.3 display fields, while the owner is editing them. */
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null);
  /** Register the record LISTED. §21.3 fixes the mode at create time, so this is
   *  the only moment the choice exists — and the creation wizard's "try listing
   *  it again later" depends on it being here. */
  const [listPublicly, setListPublicly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const roomServerId = stub?.roomServerId;
  const token = stub?.bootstrapBlindId;
  /** Ownership is per ACCOUNT, so the lookup is keyed to the signed-in one. */
  const accountId = useAuthStore((auth) => auth.user?.id ?? null);
  /** A restricted account may not PUBLISH: `POST /v1/private-rooms` refuses a
   *  `listed` creation with `account_restricted`, and the creation wizard
   *  already withholds the choice. Offering it here would walk a sanctioned
   *  member into a deterministic refusal after the signing work is done — and
   *  leave the two surfaces disagreeing about the same sanction. */
  const restricted = useAuthStore((auth) => auth.user?.account_state === 'restricted');

  /**
   * Accept a record ONLY if the room signed it — for every response, not just
   * the read.
   *
   * A PATCH or a delist answers with the same server-couriered body a GET does,
   * so verifying the read alone left an owner shown, and acting on, a forged
   * record until the next full read. One funnel means a mutation cannot be the
   * unverified door.
   */
  const accept = useCallback(
    async (record: BootstrapStub): Promise<boolean> => {
      if (
        record.signed_stub === null ||
        record.stub_signature === null ||
        !(await session.verifyDirectoryRecord(record.signed_stub, record.stub_signature))
      ) {
        // QUARANTINE the handle, do not merely refuse to show the record.
        //
        // A handle arrives in a sealed invite and is not bound to the room that
        // invite is for, so an inviter who belongs to room A can hand out A's
        // handle in an invite for room B. Failing verification here is that
        // case: this is a pointer at ANOTHER room. Left alone it keeps
        // travelling — a member who later becomes an admin copies it into every
        // invite they issue, spreading the poisoned reference through people who
        // did nothing wrong.
        //
        // Marked rather than deleted: the member is told, and forgets it
        // deliberately. It stops propagating the moment this lands.
        await session.quarantineDirectoryStub();
        setState({ kind: 'unverified' });
        return false;
      }
      // RELEASE it: the record is signed by this room, so the handle points here
      // and may travel in invites. Verification has two outcomes and both are
      // recorded — without this, "not yet checked" and "checked and fine" are
      // the same state, which is what let an unverified handle propagate.
      await session.markDirectoryStubVerified();
      setState({ kind: 'present', record });
      return true;
    },
    [session],
  );

  const read = useCallback(async (): Promise<void> => {
    if (roomServerId === undefined || token === undefined) {
      setState({ kind: 'absent' });
      return;
    }
    setBusy('refresh');
    setError(null);
    try {
      // VERIFY before believing it. The server stores `signed_stub` verbatim and
      // cannot check it — it holds no room key — so the signature is worth
      // exactly what the client's willingness to read it is worth. Fail CLOSED:
      // a record that does not verify is not shown at all, because the
      // commitments in it are what a member would bootstrap from.
      await accept(await fetchPrivateRoomBootstrap(roomServerId, token));
    } catch (err) {
      // THE READ NEVER CLEARS THE HANDLE.
      //
      // A 404 says "no record YOU can reach": §21.2 collapses an unknown room,
      // a wrong token and a malformed id into one answer, so a stale or
      // corrupted local token produces exactly this. The owner-scoped lookup
      // below narrows the MESSAGE, and it cannot narrow more than that — a
      // `null` from it means "the account signed in here owns no record for
      // this room", which a joined member on their own account, or the creator
      // signed into a second account, satisfies while the creator's record
      // stands. Clearing on that destroys the device's only copy of a
      // capability a member admitted after epoch 0 cannot re-derive, and takes
      // the directory reference out of every invite that device makes
      // afterwards.
      //
      // Deletion is the only thing that proves absence, and this device knows
      // when it performed one — so the remove action owns the clear, and it now
      // treats the server's 404 as the record already being gone, which is the
      // retry-repairs-it property this branch was standing in for.
      const status = err instanceof ApiClientError ? err.status : undefined;
      if (status === 404) {
        // A FAILED lookup is not an absent record. Folding a transient error, a
        // 401 during session expiry, or an unreachable server into the same
        // `null` as "the owner owns nothing here" would state absence on
        // exactly the evidence that proves nothing.
        const lookup =
          accountId === null
            ? { ok: false as const }
            : await findMyPrivateRoomStub({ roomServerId })
                .then((found) => ({ ok: true as const, found }))
                .catch(() => ({ ok: false as const }));
        // NEVER `absent` from a failed read. `absent` is a claim about the
        // ROOM; the lookup answers about the ACCOUNT, and a founder device
        // signed into a second account satisfies "this account owns no record"
        // while the record stands — offering registration there minted a
        // duplicate for a room that already had one.
        //
        // `absent` is reached the two ways it can be KNOWN: no stored handle at
        // all (a detached room, or one never registered), and after a removal
        // this device performed, which clears the handle. Everything else is
        // unreadable, with the lookup deciding only how to say so.
        setState({ kind: 'unreadable' });
        setError(
          lookup.ok && lookup.found === null
            ? t(
                'privateRoom.record.notYours',
                'This account holds no Licio record for this room, and the key on this device did not open one. If the record was removed, forget it here to register a new one.',
              )
            : t(
                'privateRoom.record.unreachable',
                'Licio’s record for this room could not be opened with the key this device holds. It may still exist — ask another member for a fresh invite.',
              ),
        );
      } else {
        setState({ kind: 'unreadable' });
        setError(
          t(
            'privateRoom.record.readError',
            'Could not read Licio’s record for this room right now. That is about the connection, not the record.',
          ),
        );
      }
    } finally {
      setBusy(null);
    }
  }, [roomServerId, token, t, accept, accountId]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    // RESET first, then ask. The answer belongs to `accountId`, so a sign-out or
    // an account switch must not leave the previous account's verdict standing —
    // a private-room session outlives a session, so both directions happen:
    // B inheriting A's controls, and the owner losing their own.
    setOwned(false);
    if (roomServerId === undefined || accountId === null) return;
    let live = true;
    // Fail CLOSED: an unanswerable ownership question hides the controls rather
    // than offering ones that would 403.
    void findMyPrivateRoomStub({ roomServerId })
      .then((mine) => {
        if (live) setOwned(mine !== null);
      })
      .catch(() => {
        if (live) setOwned(false);
      });
    return () => {
      live = false;
    };
  }, [roomServerId, accountId]);

  const record = state.kind === 'present' ? state.record : null;

  // Why registration is unavailable, or null when it is available.
  const registerBlockedBecause =
    accountId === null
      ? t(
          'privateRoom.record.registerNeedsAccount',
          'Sign in to have Licio store a bootstrap record for this room.',
        )
      : session.canRegisterDirectory
        ? null
        : t(
            'privateRoom.record.registerNeedsFounder',
            'Only a device that has been in this room since it was created can register a record for it — its bootstrap key is one this device never received.',
          );

  async function run(action: Exclude<Action, null>, work: () => Promise<void>): Promise<void> {
    setBusy(action);
    setError(null);
    setStatus(null);
    try {
      await work();
    } catch {
      setError(t('privateRoom.record.actionError', 'That did not go through. Try again.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h3 id={headingId} className="font-semibold text-sm">
          {t('privateRoom.record.title', 'Licio’s record of this room')}
        </h3>
        <p className="neu-inset rounded-lg p-3 text-ink-muted text-sm" role="note">
          {t(
            'privateRoom.record.note',
            'Licio stores a bootstrap pointer for this room — commitments and, if it is listed, a public name. It holds no messages, no member list, and no keys, because it never had any.',
          )}
        </p>

        {/* BESIDE the state, not instead of it.
            A removal confirmation that REPLACED the panel body left the owner
            looking at "Licio's record was removed" and nothing else — the
            re-registration this panel exists to offer was unreachable until a
            full remount, which is the one moment they are most likely to want
            it (a record removed by mistake, or removed in order to replace it).
            The handle is cleared, so the state underneath is `absent`, which
            renders the register control. */}
        {removed !== null ? (
          <p className="text-ink-muted text-sm" role="status">
            {removed}
          </p>
        ) : null}
        {state.kind === 'unverified' ? (
          <p className="text-error-on-soft text-sm" role="alert">
            {t(
              'privateRoom.record.unverified',
              'Licio returned a record that this room did not sign. It is not shown, this device has stopped handing it out in invites, and nothing about it should be trusted — forget it here once you have checked with another member.',
            )}
          </p>
        ) : state.kind === 'absent' ? (
          <div className="flex flex-col gap-2">
            <p className="text-ink-muted text-sm">
              {t(
                'privateRoom.record.none',
                'Licio holds no record of this room. Members can only join through an invite you deliver yourself.',
              )}
            </p>
            {/* THE RE-REGISTRATION PATH.
                Without it a room whose record is gone — deleted, or dropped by
                the §21.2 capability migration — could never have another, since
                registration existed only inside the creation wizard. It also
                closes a gap that predates all of that: a `detached` room had no
                way to become reachable by id.

                UNLISTED only. Publishing a public name is a create-time decision
                by §21.3 (mode is not patchable, so a listed record cannot be
                demoted-then-restored by accident), and a bootstrap pointer is
                what makes an invite resolve — which is the thing that was
                lost. */}
            {registerBlockedBecause !== null ? (
              // The action is not OFFERED where it would deterministically fail.
              // Registering is an authenticated write, and the capability is
              // bound to the room's genesis epoch, which a device admitted later
              // does not hold — so both are stated rather than discovered
              // through a generic error after the signing work is done.
              <p className="text-ink-muted text-xs" role="note">
                {registerBlockedBecause}
              </p>
            ) : (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('register', async () => {
                      // Bound to the ACCOUNT: a published pair replayed by
                      // someone else proves nothing.
                      const payload = await session.directoryStubPayload(accountId ?? undefined);
                      if (payload.registrationProof === undefined) {
                        throw new Error('registration requires a signed-in account');
                      }
                      // ADOPT BEFORE CREATING. An earlier attempt can have
                      // committed with both its response and its reconciliation
                      // lost, and nothing about creation is keyed on the room —
                      // so a retry that succeeds mints a SECOND record and
                      // orphans the first, publicly listed if that was its mode.
                      // Asking first makes the retry idempotent in the only way
                      // available: by finding what is already there.
                      const existing = await findMyPrivateRoomStub({
                        roomPublicKey: payload.roomPublicKey,
                      });
                      if (existing !== null) {
                        await session.attachDirectoryStub({
                          roomServerId: existing.room_server_id,
                          bootstrapBlindId: payload.bootstrapBlindId,
                        });
                        setStatus(
                          t(
                            'privateRoom.record.recovered',
                            'Licio already held a record for this room, and this device is now using it.',
                          ),
                        );
                        await read();
                        return;
                      }
                      let created: Awaited<ReturnType<typeof createPrivateRoomStub>> | null = null;
                      try {
                        created = await createPrivateRoomStub({
                          // `restricted` is re-read here rather than trusted from
                          // the checkbox: a sanction landing between the render
                          // and the click must not send a request the server will
                          // refuse.
                          directoryMode: listPublicly && !restricted ? 'listed' : 'unlisted',
                          // Display metadata is `listed`-only — the server
                          // REFUSES it on an unlisted record rather than
                          // dropping it — so it is sent only where it belongs.
                          ...(listPublicly && !restricted ? { displayName: session.name } : {}),
                          rendezvousPolicy: 'licio_blind',
                          signedStub: payload.signedStub,
                          stubSignature: payload.stubSignature,
                          registrationProof: payload.registrationProof,
                          bootstrapBlindId: payload.bootstrapBlindId,
                        });
                        await session.attachDirectoryStub({
                          roomServerId: created.room_server_id,
                          bootstrapBlindId: payload.bootstrapBlindId,
                        });
                      } catch (err) {
                        // SAME reconciliation the creation wizard runs, for the
                        // same reason: the POST can commit and its response be
                        // lost, or the local write can fail after it. Nothing
                        // here is keyed on the room, so a retry would mint a
                        // SECOND record while the first stayed unreachable.
                        const status = err instanceof ApiClientError ? err.status : undefined;
                        const refused = status !== undefined && status >= 400 && status < 500;
                        if (!refused) {
                          const orphan = await findMyPrivateRoomStub({
                            roomPublicKey: payload.roomPublicKey,
                          });
                          if (orphan !== null) {
                            await session.attachDirectoryStub({
                              roomServerId: orphan.room_server_id,
                              bootstrapBlindId: payload.bootstrapBlindId,
                            });
                            setStatus(
                              t(
                                'privateRoom.record.recovered',
                                'Licio already held a record for this room, and this device is now using it.',
                              ),
                            );
                            await read();
                            return;
                          }
                        }
                        throw err;
                      }
                      setStatus(
                        t(
                          'privateRoom.record.registered',
                          'Licio now holds a bootstrap record for this room. New invites can use it.',
                        ),
                      );
                      await read();
                    })
                  }
                >
                  {busy === 'register'
                    ? t('privateRoom.record.registering', 'Registering…')
                    : t('privateRoom.record.register', 'Let Licio store a bootstrap record')}
                </Button>
                {/* THE LISTED PATH EXISTS HERE, or the creation wizard's copy is
                    a promise nothing can keep.
                    §21.3 sets `directory_mode` at CREATE time and only ever
                    demotes it, so a record registered `unlisted` can never
                    become listed — and this was the only later registration
                    path. A creation whose directory step failed after the user
                    chose "listed" was therefore told to "try listing it again
                    later" with no way to do so. */}
                {restricted ? (
                  <p className="text-ink-muted text-xs" role="note">
                    {t(
                      'privateRoom.record.listRestricted',
                      'This account cannot publish a public listing right now, so the record is stored unlisted. Invites work either way.',
                    )}
                  </p>
                ) : (
                  <>
                    <Checkbox
                      label={t(
                        'privateRoom.record.alsoList',
                        'Also list this room publicly, under its name',
                      )}
                      checked={listPublicly}
                      onCheckedChange={setListPublicly}
                      disabled={busy !== null}
                    />
                    <p className="text-ink-muted text-xs" role="note">
                      {t(
                        'privateRoom.record.alsoListNote',
                        'A listed room appears in Licio’s public directory by name. The room’s contents stay private either way, and you can delist it later.',
                      )}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <dl className="flex flex-col gap-1 text-xs">
              <div className="flex gap-2">
                <dt className="text-ink-muted">
                  {t('privateRoom.record.mode', 'Discoverable by')}
                </dt>
                <dd>
                  {record === null
                    ? t('privateRoom.record.unknown', 'Reading…')
                    : record.directory_mode === 'listed'
                      ? t('privateRoom.record.listed', 'Anyone browsing Licio')
                      : t('privateRoom.record.unlisted', 'People holding an invite')}
                </dd>
              </div>
              {record?.display_name != null ? (
                <div className="flex gap-2">
                  <dt className="text-ink-muted">
                    {t('privateRoom.record.publicName', 'Published name')}
                  </dt>
                  <dd>{record.display_name}</dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="text-ink-muted">{t('privateRoom.record.id', 'Room record id')}</dt>
                <dd className="break-all font-mono">{roomServerId}</dd>
              </div>
            </dl>

            {/* THE §21.3 MUTABLE FIELDS, editable by the record's owner.
                They were write-once in practice: the only production PATCH sent
                a manifest commitment, so correcting a published name meant
                deleting the record — and the re-registration that follows is
                unlisted-only, which cannot restore a listing at all. §21.3
                exists to make exactly these correctable. */}
            {owned && record !== null && record.directory_mode === 'listed' && restricted ? (
              // A RESTRICTED OWNER MAY CLEAR, NOT PUBLISH — the same line the
              // route draws (`publishesDisplay && isRestricted`): setting a name
              // is the public act, and clearing one publishes nothing. Offering
              // the ordinary editor walked a sanctioned owner into a
              // deterministic `account_restricted` on save, while the thing they
              // most plausibly need — taking the published text DOWN — was
              // reachable only through that same refused form.
              <div className="flex flex-col gap-2">
                <p className="text-ink-muted text-xs" role="note">
                  {t(
                    'privateRoom.record.editRestricted',
                    'This account cannot publish a name or description right now. You can still remove what is published.',
                  )}
                </p>
                {record.display_name !== null || record.display_description !== null ? (
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void run('display', async () => {
                          const next = await updatePrivateRoomStub(roomServerId ?? '', {
                            displayName: null,
                            displayDescription: null,
                          });
                          if (!(await accept(next))) return;
                          setStatus(
                            t(
                              'privateRoom.record.editCleared',
                              'Removed the published name and description.',
                            ),
                          );
                        })
                      }
                    >
                      {t('privateRoom.record.clearDisplay', 'Remove the published name')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : owned && record !== null && record.directory_mode === 'listed' ? (
              editing === null ? (
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      setEditing({
                        name: record.display_name ?? '',
                        description: record.display_description ?? '',
                      })
                    }
                  >
                    {t('privateRoom.record.edit', 'Edit the published name')}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Input
                    label={t('privateRoom.record.editName', 'Published name')}
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                  <Input
                    label={t('privateRoom.record.editDescription', 'Published description')}
                    value={editing.description}
                    onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={busy !== null}
                      onClick={() =>
                        void run('display', async () => {
                          // An EMPTY field clears the value — `null` rather than
                          // `''`, because §21.3 distinguishes "no published
                          // description" from one that is the empty string, and
                          // the schema refuses the latter.
                          const next = await updatePrivateRoomStub(roomServerId ?? '', {
                            displayName: editing.name.trim() === '' ? null : editing.name.trim(),
                            displayDescription:
                              editing.description.trim() === '' ? null : editing.description.trim(),
                          });
                          // A response that does not verify is not a success:
                          // announcing one beside the forged-record warning
                          // would have the user believe the change landed.
                          if (!(await accept(next))) return;
                          setEditing(null);
                          setStatus(
                            t('privateRoom.record.edited', 'Updated what Licio publishes.'),
                          );
                        })
                      }
                    >
                      {busy === 'display'
                        ? t('privateRoom.record.saving', 'Saving…')
                        : t('privateRoom.record.save', 'Save')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setEditing(null)}
                    >
                      {t('privateRoom.record.cancelEdit', 'Cancel')}
                    </Button>
                  </div>
                </div>
              )
            ) : null}

            {owned && record !== null ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('push', async () => {
                      // Refresh the commitment a bootstrapping peer checks the
                      // manifest against. It goes stale on every manifest change,
                      // and a stale one makes an honest peer look wrong.
                      //
                      // ONLY that column. `directoryStubPayload()` signs with
                      // THIS DEVICE's key and publishes it as `room_public_key`,
                      // and the owning account can reach this control from a
                      // JOINED device — so sending the signed body along would
                      // re-sign the record under a device key members do not
                      // know, and verification would fail after an ordinary
                      // refresh. `latest_manifest_commitment` is a plain column
                      // outside the signed body, which is why it is patchable at
                      // all.
                      // Read directly — NOT through `directoryStubPayload()`,
                      // which needs the genesis epoch to derive the capability
                      // and therefore throws on every device that joined later.
                      // This column is patchable precisely because it needs no
                      // re-signing.
                      const next = await updatePrivateRoomStub(roomServerId ?? '', {
                        latestManifestCommitment: session.manifestCommitmentB64,
                      });
                      if (!(await accept(next))) return;
                      setStatus(
                        t('privateRoom.record.pushed', 'Updated the record’s manifest commitment.'),
                      );
                    })
                  }
                >
                  {busy === 'push'
                    ? t('privateRoom.record.pushing', 'Updating…')
                    : t('privateRoom.record.push', 'Refresh commitment')}
                </Button>

                {record?.directory_mode === 'listed' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('delist', async () => {
                        const next = await delistPrivateRoomStub(roomServerId ?? '');
                        if (!(await accept(next))) return;
                        setStatus(
                          t(
                            'privateRoom.record.delisted',
                            'Stopped advertising this room. Members holding an invite can still resolve it.',
                          ),
                        );
                      })
                    }
                  >
                    {busy === 'delist'
                      ? t('privateRoom.record.delisting', 'Delisting…')
                      : t('privateRoom.record.delist', 'Stop listing publicly')}
                  </Button>
                ) : null}

                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('remove', async () => {
                      // A 404 HERE means the record is already gone, which is
                      // the outcome this action wants — so it is success for
                      // cleanup purposes, and a retry after a failed local
                      // clear repairs it instead of stopping at the server's
                      // refusal. That is what lets the READ path keep the
                      // handle: deletion this device performed is the only
                      // proof of absence it has.
                      const result = await deletePrivateRoomStub(roomServerId ?? '').catch(
                        (err: unknown) => {
                          if (err instanceof ApiClientError && err.status === 404) return null;
                          throw err;
                        },
                      );
                      // FORGET the handle with the record. Left behind it would
                      // survive a reload as a pointer to nothing — and the next
                      // invite would carry it, handing a new member a capability
                      // whose first use is an unexplained 404.
                      await session.clearDirectoryStub();
                      // The SERVER's own wording, not ours: it is the sentence
                      // §21.4 requires, and rephrasing it here is how "removed
                      // Licio's record" quietly becomes "deleted the room".
                      setRemoved(
                        result?.message ??
                          t(
                            'privateRoom.record.alreadyRemoved',
                            'Licio’s record for this room is already removed. The room itself is untouched — it lives on members’ devices.',
                          ),
                      );
                    })
                  }
                >
                  {busy === 'remove'
                    ? t('privateRoom.record.removing', 'Removing…')
                    : t('privateRoom.record.remove', 'Remove Licio’s record')}
                </Button>
              </div>
            ) : null}
          </>
        )}

        {error !== null ? (
          <p className="text-error-on-soft text-sm" role="alert">
            {error}
          </p>
        ) : null}
        {/* THE EXPLICIT WAY OUT of an unreadable handle.
            The read cannot tell "this record was removed" from "this record
            belongs to another account", so it must not GUESS — and the owner
            whose record a second device removed would otherwise be stuck
            holding a key to nothing with no way to register a new one. This
            asks them to assert it: forgetting is a local act on this device,
            and afterwards the panel offers registration because the handle is
            genuinely gone rather than because a lookup was read as proof. */}
        {(state.kind === 'unreadable' || state.kind === 'unverified') &&
        roomServerId !== undefined ? (
          <div>
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run('forget', async () => {
                  await session.clearDirectoryStub();
                  // STATE DIRECTLY, not another read.
                  //
                  // `read` is a closure over the roomServerId and token that
                  // existed when it was built, and the handle has just been
                  // cleared — so re-running it starts a lookup for a record this
                  // device no longer has a capability for, and that lookup lands
                  // AFTER the re-render has already settled on `absent`,
                  // overwriting it with `unreadable`. With the handle gone, the
                  // panel then renders neither the forget control nor the
                  // registration it promised, and nothing but a remount clears
                  // it. Forgetting is a local act whose outcome is known here:
                  // this device holds no record.
                  setState({ kind: 'absent' });
                  setError(null);
                  setStatus(
                    t(
                      'privateRoom.record.forgotten',
                      'This device no longer holds a pointer to Licio’s record for this room.',
                    ),
                  );
                })
              }
            >
              {busy === 'forget'
                ? t('privateRoom.record.forgetting', 'Forgetting…')
                : t('privateRoom.record.forget', 'Forget this record on this device')}
            </Button>
          </div>
        ) : null}
        {status !== null ? (
          <p className="text-success-on-soft text-sm" role="status">
            {status}
          </p>
        ) : null}
      </section>
    </Card>
  );
}
