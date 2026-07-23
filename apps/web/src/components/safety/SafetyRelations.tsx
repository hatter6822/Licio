// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.2 block + mute management.  `BlockMuteButtons` is the per-user
// affordance (block = bilateral; mute = one-directional, optionally timed);
// `SafetyRelations` lists the caller's blocks + mutes with an undo.  Lists are
// private to the owner; the blocked/muted user is never notified.
//
// Both affordances address the target by its PUBLIC HANDLE.  That is the only
// identifier a reader ever holds: the public contribution projection withholds
// `author_user_id` (§19.5), so a user-id-only control could never be mounted on
// a content surface — which is exactly why the SPEC §B "two-tap
// report/block/mute" affordance is reached through the report sheet
// (`ReportSheet`), where the author's handle is in hand.
import { MUTE_DURATIONS, type MuteDuration } from '@licio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  createBlockByHandle,
  createMuteByHandle,
  fetchBlocks,
  fetchMutes,
  removeBlock,
  removeMute,
} from '../../lib/safety-api.js';
import { Button } from '../ui/Button/index.js';
import { Select } from '../ui/Select/index.js';
import { useToast } from '../ui/Toast/index.js';

/** Human labels for the four API-supported mute windows (WS-J.1.2b). */
const MUTE_DURATION_LABELS: Record<MuteDuration, string> = {
  '1d': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  forever: 'Until I unmute',
};

/**
 * Per-user block + mute controls.  `handle` is the target's public handle;
 * `onDone` lets a host surface (the report sheet) close itself once the action
 * lands.  The mute window is chosen here rather than defaulted silently — the
 * API has always accepted a duration, and a timed mute is the gentler action a
 * reader usually wants.
 */
export function BlockMuteButtons({
  handle,
  onDone,
}: {
  handle: string;
  onDone?: () => void;
}): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [duration, setDuration] = useState<MuteDuration>('7d');

  /** Both mutations fail LOUDLY: a silent no-op would leave the reader believing
   *  they had blocked someone they had not. */
  const failed = (fallback: string) => (error: unknown) => {
    toast({
      message: error instanceof ApiClientError ? error.message : fallback,
      tone: 'error',
    });
  };

  const block = useMutation({
    mutationFn: () => createBlockByHandle(handle),
    onSuccess: () => {
      toast({
        message: t('block.done', 'Blocked. You will no longer see each other.'),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.blocks() });
      onDone?.();
    },
    onError: failed(t('block.failed', 'We could not block that account.')),
  });

  const mute = useMutation({
    mutationFn: () => createMuteByHandle(handle, duration),
    onSuccess: () => {
      toast({
        message: t('mute.done', 'Muted. You will no longer see their content.'),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mutes() });
      onDone?.();
    },
    onError: failed(t('mute.failed', 'We could not mute that account.')),
  });

  const busy = block.isPending || mute.isPending;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t('mute.duration.label', 'Mute for')}
          value={duration}
          onValueChange={(value) => setDuration(value as MuteDuration)}
          options={MUTE_DURATIONS.map((value) => ({
            value,
            label: t(`mute.duration.${value}`, MUTE_DURATION_LABELS[value]),
          }))}
          className="min-w-40"
        />
        <Button
          variant="ghost"
          loading={mute.isPending}
          disabled={busy}
          onClick={() => mute.mutate()}
        >
          {t('mute.action', 'Mute')} @{handle}
        </Button>
      </div>
      <div>
        <Button
          variant="secondary"
          loading={block.isPending}
          disabled={busy}
          onClick={() => block.mutate()}
        >
          {t('block.action', 'Block')} @{handle}
        </Button>
        <p className="mt-1 text-xs text-ink-muted">
          {t(
            'block.explain',
            'Blocking hides you from each other and stops all interaction. They are not told.',
          )}
        </p>
      </div>
    </div>
  );
}

export function SafetyRelations(): React.ReactElement {
  const t = useT();
  const queryClient = useQueryClient();
  const blocks = useQuery({ queryKey: queryKeys.blocks(), queryFn: () => fetchBlocks() });
  const mutes = useQuery({ queryKey: queryKeys.mutes(), queryFn: () => fetchMutes() });
  const unblock = useMutation({
    mutationFn: (blockId: string) => removeBlock(blockId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.blocks() }),
  });
  const unmute = useMutation({
    mutationFn: (muteId: string) => removeMute(muteId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.mutes() }),
  });

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="blocks-heading" className="flex flex-col gap-2">
        <h2 id="blocks-heading" className="text-base font-semibold text-ink">
          {t('safety.blocked', 'Blocked accounts')}
        </h2>
        {blocks.data && blocks.data.blocks.length === 0 ? (
          <p className="text-ink-muted">{t('safety.noBlocks', 'You have not blocked anyone.')}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {blocks.data?.blocks.map((b) => (
            <li
              key={b.block_id}
              className="flex items-center justify-between rounded-md border border-line bg-canvas p-3"
            >
              {/* The handle, not a truncated opaque id: an unblock list a reader
                  cannot read is not a management surface. */}
              <span className="text-sm text-ink">@{b.blocked_user_handle}</span>
              <Button variant="ghost" onClick={() => unblock.mutate(b.block_id)}>
                {t('safety.unblock', 'Unblock')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="mutes-heading" className="flex flex-col gap-2">
        <h2 id="mutes-heading" className="text-base font-semibold text-ink">
          {t('safety.muted', 'Muted accounts')}
        </h2>
        {mutes.data && mutes.data.mutes.length === 0 ? (
          <p className="text-ink-muted">{t('safety.noMutes', 'You have not muted anyone.')}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {mutes.data?.mutes.map((m) => (
            <li
              key={m.mute_id}
              className="flex items-center justify-between rounded-md border border-line bg-canvas p-3"
            >
              <span className="text-sm text-ink">
                @{m.muted_user_handle}
                {m.expires_at !== null ? (
                  <span className="ms-2 text-xs text-ink-muted">
                    {t('safety.muteUntil', 'until {date}', {
                      date: new Date(m.expires_at).toLocaleDateString(),
                    })}
                  </span>
                ) : null}
              </span>
              <Button variant="ghost" onClick={() => unmute.mutate(m.mute_id)}>
                {t('safety.unmute', 'Unmute')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
