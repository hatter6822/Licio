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
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ApiClientError, RoomVisibilityBlockedError } from '../../../lib/api.js';
import { fieldErrorsFrom } from '../../../lib/form-errors.js';
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
  /**
   * Field-keyed messages from a failed save, `form` carrying the whole-form one.
   *
   * The save was SILENT: `useUpdateRoomSettingsMutation` has no `onError`, the
   * global `MutationCache.onError` only emits RUM telemetry, and nothing here
   * rendered `settings.error` — so a rejected PATCH showed no alert at all while
   * the Selects kept displaying the steward's chosen value.  It read as SUCCESS.
   *
   * That is the DEFAULT path for a non-staff steward, not an edge case: the route
   * runs `checkGovernanceEligibility`, which fails closed — `resolveCompliance()`
   * returns null outside `NODE_ENV=test`, giving `eligibility_unavailable`, and a
   * KYC-less account gives `kyc_required`.  Both arrive with a fully populated
   * message that was being discarded.
   *
   * Per-field via `fieldErrorsFrom`, matching `RoomCreateForm` rather than
   * inventing a second convention; the sibling `LensManager` in this same file
   * already rendered its own error, which is what made the omission visible.
   */
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

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
        {...(saveErrors['join_model'] ? { error: saveErrors['join_model'] } : {})}
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
        {...(saveErrors['posting_policy'] ? { error: saveErrors['posting_policy'] } : {})}
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
        onClick={() => {
          setSaveErrors({});
          settings.mutate(
            { join_model: effectiveJoinModel, posting_policy: postingPolicy },
            {
              onError: (error) =>
                setSaveErrors(
                  fieldErrorsFrom(
                    error,
                    t('roomSettings.save.failed', 'The settings could not be saved.'),
                  ),
                ),
            },
          );
        }}
      >
        {t('roomSettings.save', 'Save settings')}
      </Button>
      {saveErrors['form'] ? (
        <p role="alert" className="text-error-on-soft text-sm">
          {saveErrors['form']}
        </p>
      ) : null}
      {/* The controls deliberately KEEP the steward's choice after a failure.
          Re-seeding them from `room` would discard the edit they are being asked
          to retry — and could not work anyway: the server value did not change,
          so a `useEffect` keyed on it never fires.  The alert is what removes the
          reads-as-success problem; the dialog unmounts on tab switch, which
          bounds how long an unsaved choice can linger. */}

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
        {/* The cascade's refusal, WITH the stories to resolve.  The server
            names every public story a canonical-URL collision refused to
            contain precisely so a steward can act on each one; rendering a
            count — or nothing at all, as this did — leaves them holding a
            number and no way to find what it counts. */}
        {cascade.error instanceof RoomVisibilityBlockedError ? (
          <div role="alert" className="flex flex-col gap-1 text-sm">
            <p className="text-error-on-soft">{cascade.error.message}</p>
            <ul className="flex flex-col gap-1">
              {cascade.error.blockedStoryIds.map((storyId) => (
                <li key={storyId}>
                  <Link
                    to="/stories/$storyId"
                    params={{ storyId }}
                    className="text-primary-on-soft underline-offset-2 hover:underline"
                  >
                    {t('roomSettings.cascade.blockedStory', 'Resolve this duplicate')}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : cascade.error ? (
          <p role="alert" className="text-error-on-soft text-sm">
            {cascade.error instanceof ApiClientError
              ? cascade.error.message
              : t('roomSettings.cascade.failed', 'The visibility change could not be applied.')}
          </p>
        ) : null}
      </div>

      {/* WS-G.2.2 — interpretation lenses (steward-managed; server enforces role). */}
      <LensManager roomId={roomId} />
    </section>
  );
}
