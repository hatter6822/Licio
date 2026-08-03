// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 / PRIVATE_SPEC §4.2 — the public directory of `listed` private rooms.
//
// `listed` is defined as "the room directory can show the room shell", so a
// `listed` room that nothing enumerates is a mode that exists only on paper —
// which is what this surface fixes.  Only rooms whose creator explicitly chose
// `listed` ever appear here; `unlisted` and `detached` rooms are absent from the
// query itself, not filtered out afterwards.
//
// What it deliberately is NOT is a way in.  A P2P room is invite-only (§4.1
// `join_model='invite'`), and the server holds no key that could admit anyone,
// so the honest affordance is: see that the room exists, read what it says about
// itself, and copy its id to ask a member for an invite.  Any button here that
// implied "join" would be a promise the architecture cannot keep.

import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { copyText } from '../../../lib/clipboard.js';
import { type DirectoryEntry, listPrivateRoomDirectory } from '../../../lib/private-rooms-api.js';
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';
import { EmptyState } from '../../ui/EmptyState/index.js';

export function PrivateRoomDirectory(): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      setBusy(true);
      setError(null);
      try {
        const page = await listPrivateRoomDirectory(after !== undefined ? { cursor: after } : {});
        // APPEND on a paged read, REPLACE on a fresh one — a "load more" that
        // silently dropped the earlier page would read as the list resetting.
        setEntries((prev) =>
          after === undefined ? page.entries : [...(prev ?? []), ...page.entries],
        );
        setCursor(page.next_cursor);
      } catch {
        setError(
          t('privateRoom.directory.error', 'Could not load the directory. Check your connection.'),
        );
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function copyId(roomServerId: string): Promise<void> {
    // Only claim it was copied if it WAS — the id is shown in full above the
    // button either way, so a failed write costs the user nothing but a false
    // "copied" costs them the paste.
    if (await copyText(roomServerId)) setCopiedId(roomServerId);
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-semibold text-sm">
        {t('privateRoom.directory.title', 'Listed private rooms')}
      </h2>
      <p className="text-ink-muted text-xs">
        {t(
          'privateRoom.directory.help',
          'Rooms whose members chose to publish a name. Their messages stay end-to-end encrypted and on member devices — being listed only means the room says it exists. You still need an invite from a member to join.',
        )}
      </p>

      {error !== null ? (
        <p className="text-error-on-soft text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {entries !== null && entries.length === 0 && error === null ? (
        <EmptyState
          icon="circle-info"
          title={t('privateRoom.directory.empty', 'No listed rooms yet')}
          description={t(
            'privateRoom.directory.emptyDesc',
            'Private rooms are unlisted by default, so most never appear here.',
          )}
        />
      ) : null}

      <ul className="flex flex-col gap-2">
        {(entries ?? []).map((entry) => (
          <li key={entry.room_server_id}>
            <Card>
              <div className="flex flex-col gap-1">
                <p className="font-semibold text-sm">
                  {entry.display_name ??
                    t('privateRoom.directory.unnamed', 'Room without a published name')}
                </p>
                {entry.display_description !== null ? (
                  <p className="text-ink-muted text-xs">{entry.display_description}</p>
                ) : null}
                <p className="break-all font-mono text-ink-muted text-xs">{entry.room_server_id}</p>
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void copyId(entry.room_server_id)}
                  >
                    {copiedId === entry.room_server_id
                      ? t('privateRoom.directory.copied', 'Room id copied')
                      : t('privateRoom.directory.copy', 'Copy room id to request an invite')}
                  </Button>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>

      {cursor !== null ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void load(cursor)}
            disabled={busy}
          >
            {busy
              ? t('privateRoom.directory.loading', 'Loading…')
              : t('privateRoom.directory.more', 'Show more rooms')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
