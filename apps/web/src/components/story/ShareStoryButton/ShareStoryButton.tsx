// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story share affordance: Web Share API when available; clipboard fallback.
// (The former §10.5 origin-context prompt for elevated-SCOI stories was
// removed with the SCOI reader-warning surfaces; the "Where interpretations
// differ" section on the story page remains the divergence surface.)

import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface ShareStoryButtonProps {
  title: string;
  /** The in-app story URL to share. */
  url: string;
}

type ShareState = 'idle' | 'shared' | 'copied';

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

export function ShareStoryButton({ title, url }: ShareStoryButtonProps): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<ShareState>('idle');

  const share = async (): Promise<void> => {
    try {
      setState(await deliver({ title, text: '', url }));
    } catch {
      setState('idle'); // user cancelled the native sheet / clipboard denied
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" onClick={() => void share()}>
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
