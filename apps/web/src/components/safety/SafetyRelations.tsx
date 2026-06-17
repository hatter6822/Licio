// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.2 block + mute management.  `BlockMuteButtons` is the per-user
// affordance (block = bilateral; mute = one-directional, optionally timed);
// `SafetyRelations` lists the caller's blocks + mutes with an undo.  Lists are
// private to the owner; the blocked/muted user is never notified.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '../../i18n/I18nProvider.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  createBlock,
  createMute,
  fetchBlocks,
  fetchMutes,
  removeBlock,
  removeMute,
} from '../../lib/safety-api.js';
import { Button } from '../ui/Button/index.js';
import { useToast } from '../ui/Toast/index.js';

export function BlockMuteButtons({ userId }: { userId: string }): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const block = useMutation({
    mutationFn: () => createBlock(userId),
    onSuccess: () => {
      toast({
        message: t('block.done', 'Blocked. You will no longer see each other.'),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.blocks() });
    },
  });
  const mute = useMutation({
    mutationFn: () => createMute(userId),
    onSuccess: () => {
      toast({
        message: t('mute.done', 'Muted. You will no longer see their content.'),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mutes() });
    },
  });
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" loading={block.isPending} onClick={() => block.mutate()}>
        {t('block.action', 'Block')}
      </Button>
      <Button variant="ghost" loading={mute.isPending} onClick={() => mute.mutate()}>
        {t('mute.action', 'Mute')}
      </Button>
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
        <h1 id="blocks-heading" className="text-2xl font-semibold text-ink">
          {t('safety.blocked', 'Blocked accounts')}
        </h1>
        {blocks.data && blocks.data.blocks.length === 0 ? (
          <p className="text-ink-muted">{t('safety.noBlocks', 'You have not blocked anyone.')}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {blocks.data?.blocks.map((b) => (
            <li
              key={b.block_id}
              className="flex items-center justify-between rounded-md border border-line bg-canvas p-3"
            >
              <span className="font-mono text-sm text-ink-muted">
                {b.blocked_user_id.slice(0, 8)}
              </span>
              <Button variant="ghost" onClick={() => unblock.mutate(b.block_id)}>
                {t('safety.unblock', 'Unblock')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="mutes-heading" className="flex flex-col gap-2">
        <h2 id="mutes-heading" className="text-2xl font-semibold text-ink">
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
              <span className="font-mono text-sm text-ink-muted">
                {m.muted_user_id.slice(0, 8)}
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
