// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story share affordance: Web Share API when available; clipboard fallback.
// (The former §10.5 origin-context prompt for elevated-SCOI stories was
// removed with the SCOI reader-warning surfaces; the "Where interpretations
// differ" section on the story page remains the divergence surface.)
//
// Two presentations, ONE behaviour: the labelled button, and the `iconOnly`
// one the story page's compact action row uses. Icon-only keeps everything the
// label carried — an `aria-label` names the control, a Tooltip shows that name
// on hover AND focus (WCAG 1.4.13), and the clipboard confirmation becomes a
// transient check on the glyph plus a live-region announcement, so the feedback
// is never silently dropped along with the text.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { copyText } from '../../../lib/clipboard.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { Tooltip } from '../../ui/Tooltip/index.js';

export interface ShareStoryButtonProps {
  title: string;
  /** The in-app story URL to share. */
  url: string;
  /** Compact presentation: the share glyph alone, named for assistive tech. */
  iconOnly?: boolean;
}

type ShareState = 'idle' | 'shared' | 'copied';

/** How long the icon-only button holds its "copied" check before returning to
 *  the share glyph (the labelled variant keeps its text confirmation). */
const CONFIRM_MS = 2_500;

async function deliver(payload: { title: string; text: string; url: string }): Promise<ShareState> {
  const nav = navigator as Navigator & {
    share?: (data: { title: string; text: string; url: string }) => Promise<void>;
  };
  if (typeof nav.share === 'function') {
    await nav.share(payload);
    return 'shared';
  }
  // A clipboard that is absent and one that DENIES are the same outcome here:
  // nothing was written, so the caller's existing "stay idle, claim nothing"
  // branch is the honest answer. Previously the absent case threw a TypeError
  // into that same branch — right by accident; now it is right on purpose.
  return (await copyText(`${payload.text} ${payload.url}`.trim())) ? 'copied' : 'idle';
}

export function ShareStoryButton({
  title,
  url,
  iconOnly = false,
}: ShareStoryButtonProps): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<ShareState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending reset on unmount so a state update never lands on a gone
  // component (and a fast re-share restarts the window rather than stacking).
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const share = async (): Promise<void> => {
    let next: ShareState;
    try {
      next = await deliver({ title, text: '', url });
    } catch {
      next = 'idle'; // user cancelled the native sheet / clipboard denied
    }
    setState(next);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    if (iconOnly && next !== 'idle') {
      resetTimer.current = setTimeout(() => setState('idle'), CONFIRM_MS);
    }
  };

  const label = t('share.button', 'Share');
  const copied = t('share.copied', 'Link copied to clipboard.');

  if (iconOnly) {
    return (
      <span className="inline-flex items-center">
        <Tooltip content={label}>
          <Button iconOnly variant="ghost" aria-label={label} onClick={() => void share()}>
            <Icon name={state === 'copied' ? 'check' : 'share'} className="size-5" />
          </Button>
        </Tooltip>
        {/* The confirmation still reaches assistive tech even though the visible
            feedback is now the glyph swap: `<output>` is a polite live region. */}
        <output className="sr-only">{state === 'copied' ? copied : ''}</output>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" onClick={() => void share()}>
        <Icon name="share" className="size-4" />
        {label}
      </Button>
      {state === 'copied' ? <output className="text-xs text-ink-muted">{copied}</output> : null}
    </span>
  );
}
