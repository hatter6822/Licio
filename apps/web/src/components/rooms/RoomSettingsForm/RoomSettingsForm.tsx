// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.3c — the steward room-settings surface (rendered only when the viewer
// is a room steward). Two distinct controls, matching the two backend paths:
//   • join_model / posting_policy — a plain settings write (updateRoomSettings).
//     A PUBLIC room locks the join control to `open` (coherence; the server
//     coerces it anyway).
//   • the public⇄private VISIBILITY cascade — a separate, confirmed action
//     (changeRoomVisibility), because flipping visibility cascades content
//     (public→private forces every public story room_only). It is NOT a plain
//     settings write — the settings endpoint rejects a visibility change.
import type { RoomDetail, RoomJoinModel, RoomPostingPolicy } from '@licio/shared';
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import {
  useChangeRoomVisibilityMutation,
  useUpdateRoomSettingsMutation,
} from '../../../lib/queries.js';
import { Button } from '../../ui/Button/index.js';
import { Select } from '../../ui/Select/index.js';
import { LensManager } from '../LensManager/index.js';

export interface RoomSettingsFormProps {
  roomId: string;
  room: RoomDetail;
}

export function RoomSettingsForm({ roomId, room }: RoomSettingsFormProps): React.ReactElement {
  const t = useT();
  const settings = useUpdateRoomSettingsMutation(roomId);
  const cascade = useChangeRoomVisibilityMutation(roomId);
  const isPublic = room.visibility === 'public';
  const [joinModel, setJoinModel] = useState<RoomJoinModel>(room.join_model);
  const [postingPolicy, setPostingPolicy] = useState<RoomPostingPolicy>(room.posting_policy);
  const [confirmCascade, setConfirmCascade] = useState(false);

  // Coherence: a public room is open-join only (the server coerces this too).
  const effectiveJoinModel = isPublic ? 'open' : joinModel;

  return (
    <section
      aria-label={t('roomSettings.title', 'Room settings')}
      className="flex flex-col gap-3 rounded-lg border border-line p-4"
    >
      <h2 className="font-medium text-ink text-sm">{t('roomSettings.title', 'Room settings')}</h2>

      <Select
        label={t('roomSettings.join', 'How members join')}
        value={effectiveJoinModel}
        onValueChange={(v) => setJoinModel(v as RoomJoinModel)}
        disabled={isPublic}
        {...(isPublic
          ? {
              helperText: t(
                'roomSettings.join.publicLock',
                'Public rooms are always open to join.',
              ),
            }
          : {})}
        options={[
          { value: 'open', label: t('roomCreate.join.open', 'Open') },
          { value: 'request_approval', label: t('roomCreate.join.request', 'Request approval') },
          { value: 'invite', label: t('roomCreate.join.invite', 'Invite only') },
        ]}
      />
      <Select
        label={t('roomSettings.posting', 'Who can post')}
        value={postingPolicy}
        onValueChange={(v) => setPostingPolicy(v as RoomPostingPolicy)}
        options={[
          { value: 'all_members', label: t('roomCreate.posting.all', 'All members') },
          {
            value: 'experts_and_stewards',
            label: t('roomCreate.posting.experts', 'Experts and stewards'),
          },
        ]}
      />
      <Button
        variant="secondary"
        disabled={settings.isPending}
        onClick={() =>
          settings.mutate({ join_model: effectiveJoinModel, posting_policy: postingPolicy })
        }
      >
        {t('roomSettings.save', 'Save settings')}
      </Button>

      {/* The visibility cascade — confirmed, separate from the settings write. */}
      <div className="flex flex-col gap-2 border-line border-t pt-3">
        <p className="text-ink-muted text-sm">
          {isPublic
            ? t(
                'roomSettings.toPrivate.note',
                'Making this room private forces every public post in it to in-room only.',
              )
            : t(
                'roomSettings.toPublic.note',
                'Making this room public lets anyone read it; existing posts stay in-room until each author widens them.',
              )}
        </p>
        {confirmCascade ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              disabled={cascade.isPending}
              onClick={() => cascade.mutate(isPublic ? 'private' : 'public')}
            >
              {t('roomSettings.cascade.confirm', 'Confirm')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmCascade(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setConfirmCascade(true)}>
            {isPublic
              ? t('roomSettings.makePrivate', 'Make room private')
              : t('roomSettings.makePublic', 'Make room public')}
          </Button>
        )}
      </div>

      {/* WS-G.2.2 — interpretation lenses (steward-managed; server enforces role). */}
      <LensManager roomId={roomId} />
    </section>
  );
}
