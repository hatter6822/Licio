// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 / PRIVATE_SPEC §21.2–§21.4 — what Licio publishes about this room,
// and the controls for changing it.
//
// This is the surface the §21.3/§21.4 client calls existed for.  Without it the
// directory record was write-once at creation: a member could see the room was
// registered and had no way to read what the server actually serves, refresh the
// manifest commitment a bootstrapping peer verifies against, stop advertising a
// listed name, or remove the record.
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
import {
  type BootstrapStub,
  deletePrivateRoomStub,
  delistPrivateRoomStub,
  fetchPrivateRoomBootstrap,
  updatePrivateRoomStub,
} from '../../../lib/private-rooms-api.js';
import type { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';

export interface DirectoryRecordPanelProps {
  session: PrivateRoomSession;
  /** Only an admin sees the mutating controls (the server enforces creator-only
   *  regardless — this keeps the UI from offering what it cannot do). */
  isAdmin: boolean;
}

type Action = 'refresh' | 'push' | 'delist' | 'remove' | null;

export function DirectoryRecordPanel({
  session,
  isAdmin,
}: DirectoryRecordPanelProps): React.ReactElement | null {
  const t = useT();
  const headingId = useId();
  const stub = session.directoryStub;
  const [record, setRecord] = useState<BootstrapStub | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const roomServerId = stub?.roomServerId;
  const token = stub?.bootstrapBlindId;

  const read = useCallback(async (): Promise<void> => {
    if (roomServerId === undefined || token === undefined) return;
    setBusy('refresh');
    setError(null);
    try {
      setRecord(await fetchPrivateRoomBootstrap(roomServerId, token));
    } catch {
      setError(
        t(
          'privateRoom.record.readError',
          'Could not read Licio’s record for this room. It may have been removed.',
        ),
      );
    } finally {
      setBusy(null);
    }
  }, [roomServerId, token, t]);

  useEffect(() => {
    void read();
  }, [read]);

  // A `detached` room, or one whose registration never succeeded, has no record
  // to show — and inventing an empty one would suggest there is something here
  // to manage.
  if (stub === undefined) return null;

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
                <dd className="break-all font-mono">{stub.roomServerId}</dd>
              </div>
            </dl>

            {isAdmin ? (
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
                      const payload = await session.directoryStubPayload();
                      const next = await updatePrivateRoomStub(stub.roomServerId, {
                        latestManifestCommitment: payload.manifestKeyCommitment,
                        signedStub: payload.signedStub,
                        stubSignature: payload.stubSignature,
                      });
                      setRecord(next);
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
                        const next = await delistPrivateRoomStub(stub.roomServerId);
                        setRecord(next);
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
                      const result = await deletePrivateRoomStub(stub.roomServerId);
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
