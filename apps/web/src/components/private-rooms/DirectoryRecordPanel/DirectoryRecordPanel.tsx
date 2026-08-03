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
import { Input } from '../../ui/Input/index.js';

export interface DirectoryRecordPanelProps {
  session: PrivateRoomSession;
}

type Action = 'refresh' | 'push' | 'delist' | 'remove' | 'register' | 'display' | null;

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
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const roomServerId = stub?.roomServerId;
  const token = stub?.bootstrapBlindId;
  /** Ownership is per ACCOUNT, so the lookup is keyed to the signed-in one. */
  const accountId = useAuthStore((auth) => auth.user?.id ?? null);

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
    async (record: BootstrapStub): Promise<void> => {
      if (
        record.signed_stub === null ||
        record.stub_signature === null ||
        !(await session.verifyDirectoryRecord(record.signed_stub, record.stub_signature))
      ) {
        setState({ kind: 'unverified' });
        return;
      }
      setState({ kind: 'present', record });
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
      // A 404 is DECISIVE: §21.2 collapses unknown-room, wrong-token and
      // malformed-id into it, so with a capability in hand it means the record
      // is gone. That is the state a re-registration answers — and it is also
      // permission to drop the local handle, which is otherwise unrepairable
      // (a retry of DELETE stops at the same 404 before reaching the cleanup).
      const status = err instanceof ApiClientError ? err.status : undefined;
      if (status === 404) {
        setState({ kind: 'absent' });
        await session.clearDirectoryStub();
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
  }, [roomServerId, token, t, session, accept]);

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

        {removed !== null ? (
          <p className="text-ink-muted text-sm" role="status">
            {removed}
          </p>
        ) : state.kind === 'unverified' ? (
          <p className="text-error-on-soft text-sm" role="alert">
            {t(
              'privateRoom.record.unverified',
              'Licio returned a record for this room that the room did not sign. It is not shown, and nothing here should be trusted until you can check with another member.',
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
                      const payload = await session.directoryStubPayload();
                      let created: Awaited<ReturnType<typeof createPrivateRoomStub>> | null = null;
                      try {
                        created = await createPrivateRoomStub({
                          directoryMode: 'unlisted',
                          rendezvousPolicy: 'licio_blind',
                          signedStub: payload.signedStub,
                          stubSignature: payload.stubSignature,
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
            {owned && record !== null && record.directory_mode === 'listed' ? (
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
                          await accept(next);
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
                      await accept(next);
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
                        await accept(next);
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
                      const result = await deletePrivateRoomStub(roomServerId ?? '');
                      // FORGET the handle with the record. Left behind it would
                      // survive a reload as a pointer to nothing — and the next
                      // invite would carry it, handing a new member a capability
                      // whose first use is an unexplained 404.
                      //
                      // If THIS write fails the action reports failure, and a
                      // retry cannot repair it: the second DELETE stops at the
                      // server's 404 first. The read path handles that — a 404
                      // with a capability in hand is decisive, so it clears the
                      // handle itself. The repair is a reload, not a dead end.
                      await session.clearDirectoryStub();
                      // The SERVER's own wording, not ours: it is the sentence
                      // §21.4 requires, and rephrasing it here is how "removed
                      // Licio's record" quietly becomes "deleted the room".
                      setRemoved(result.message);
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
        {status !== null ? (
          <p className="text-success-on-soft text-sm" role="status">
            {status}
          </p>
        ) : null}
      </section>
    </Card>
  );
}
