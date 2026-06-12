// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story share affordance with the §10.5 origin-context prompt
// (WS-H.4.3c): sharing a CONTEXT-SENSITIVE story (elevated SCOI —
// communities read it differently) first offers to include a one-line
// origin note, because the share is exactly the cross-community move that
// strips context. The prompt is informative and optional — "share as is"
// always works. Web Share API when available; clipboard fallback.

import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface ShareStoryButtonProps {
  title: string;
  /** The in-app story URL to share. */
  url: string;
  /** SCOI needs-context gate from the interpretations read. */
  needsContext: boolean;
  /**
   * True while the interpretations read is still in flight: sharing waits
   * so an early click can never bypass the §10.5 prompt. A FAILED read
   * enables sharing with needsContext false — the status is unknowable,
   * and an offline reader must still be able to share.
   */
  contextStatusPending?: boolean;
}

type ShareState = 'idle' | 'prompt' | 'shared' | 'copied';

async function deliver(payload: { title: string; text: string; url: string }): Promise<ShareState> {
  const nav = navigator as Navigator & {
    share?: (data: { title: string; text: string; url: string }) => Promise<void>;
  };
  if (typeof nav.share === 'function') {
    await nav.share(payload);
    return 'shared';
  }
  await navigator.clipboard.writeText(`${payload.text} ${payload.url}`.trim());
  return 'copied';
}

export function ShareStoryButton({
  title,
  url,
  needsContext,
  contextStatusPending = false,
}: ShareStoryButtonProps): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<ShareState>('idle');

  const share = async (withContext: boolean): Promise<void> => {
    const contextNote = withContext
      ? t(
          'share.originContext',
          'Context: communities are reading this story differently — see "Where interpretations differ" on the story page.',
        )
      : '';
    try {
      setState(await deliver({ title, text: contextNote, url }));
    } catch {
      setState('idle'); // user cancelled the native sheet / clipboard denied
    }
  };

  if (state === 'prompt') {
    return (
      <div
        role="group"
        aria-label={t('share.promptLabel', 'Share options for a context-sensitive story')}
        className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-surface p-2"
      >
        <span className="text-xs text-ink">
          {t('share.contextSensitive', 'This item is context-sensitive. Include origin context?')}
        </span>
        <Button variant="primary" onClick={() => void share(true)}>
          {t('share.withContext', 'Share with context')}
        </Button>
        <Button variant="secondary" onClick={() => void share(false)}>
          {t('share.asIs', 'Share as is')}
        </Button>
        <Button variant="ghost" onClick={() => setState('idle')}>
          {t('common.cancel', 'Cancel')}
        </Button>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="secondary"
        disabled={contextStatusPending}
        onClick={() => {
          if (needsContext) setState('prompt');
          else void share(false);
        }}
      >
        <Icon name="external-link" className="size-4" />
        {t('share.button', 'Share')}
      </Button>
      {state === 'copied' ? (
        <output className="text-xs text-ink-muted">
          {t('share.copied', 'Link copied to clipboard.')}
        </output>
      ) : null}
    </span>
  );
}
