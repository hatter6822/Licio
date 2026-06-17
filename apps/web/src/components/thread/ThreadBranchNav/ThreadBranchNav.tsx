// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread structured-branch navigator (WS-B.2.12). A thread is read through six
// fixed branches rather than a single flat comment stream; "Overview" is the
// default landing branch. The WAI-ARIA tab pattern (tablist/tab/tabpanel +
// roving tabindex + arrow-key navigation) is delegated wholesale to the shared
// `Tabs` primitive so the branch bar is a single, audited a11y implementation.
//
// Branch content can arrive lazily: while a branch is loading we render a
// `Skeleton` inside the already-mounted panel. Because `Tabs` keeps the panel
// element stable and only swaps its children, switching from skeleton to content
// neither shifts the surrounding layout nor steals focus from the active tab.
import type { ReactNode } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { Skeleton } from '../../ui/Skeleton/index.js';
import { Tabs } from '../../ui/Tabs/index.js';

/** The six canonical thread branches (WS-B.2.12). Order is the tab order. */
export const BRANCH_IDS = [
  'overview',
  'questions',
  'evidence',
  'challenges',
  'lenses',
  'chronology',
] as const;

export type BranchId = (typeof BRANCH_IDS)[number];

/** Per-branch content. `loading` shows a skeleton without shifting layout. */
export interface BranchContent {
  /** Rendered inside the branch panel once resolved. */
  content?: ReactNode;
  /** While true the panel shows a skeleton placeholder instead of `content`. */
  loading?: boolean;
}

export interface ThreadBranchNavProps {
  /**
   * Static content for each branch. Mutually exclusive with `renderBranch`; if
   * both are supplied `renderBranch` wins (it can return a skeleton itself).
   */
  branches?: Partial<Record<BranchId, BranchContent>>;
  /**
   * Render-prop alternative: return the node for a branch on demand. Return a
   * `<Skeleton/>` while a branch's data is in flight.
   */
  renderBranch?: (id: BranchId) => ReactNode;
  /** Landing branch. Defaults to 'overview'. */
  defaultBranch?: BranchId;
  /** Fires when the active branch changes (analytics / URL sync, in WS-C). */
  onBranchChange?: (id: BranchId) => void;
  /** Opens the composer (WS-C). The floating Contribute button calls this. */
  onContribute?: () => void;
  className?: string;
}

/** Default English labels for the branch tabs; overridable per-locale via `t`. */
const BRANCH_LABELS: Record<BranchId, { key: string; text: string }> = {
  overview: { key: 'thread.branch.overview', text: 'Overview' },
  questions: { key: 'thread.branch.questions', text: 'Questions' },
  evidence: { key: 'thread.branch.evidence', text: 'Evidence' },
  challenges: { key: 'thread.branch.challenges', text: 'Challenges' },
  lenses: { key: 'thread.branch.lenses', text: 'Local & Expert Lenses' },
  chronology: { key: 'thread.branch.chronology', text: 'Chronology' },
};

function isBranchId(value: string): value is BranchId {
  return (BRANCH_IDS as readonly string[]).includes(value);
}

export function ThreadBranchNav({
  branches,
  renderBranch,
  defaultBranch = 'overview',
  onBranchChange,
  onContribute,
  className,
}: ThreadBranchNavProps): React.ReactElement {
  const t = useT();

  const tabs = BRANCH_IDS.map((id) => {
    const label = BRANCH_LABELS[id];
    return { id, label: t(label.key, label.text) };
  });

  // Number of skeleton lines while a branch loads — enough to read as a block
  // of prose, not so many it dwarfs typical content (no layout-shift goal).
  const renderPanel = (activeId: string): ReactNode => {
    if (!isBranchId(activeId)) return null;

    if (renderBranch) return renderBranch(activeId);

    const branch = branches?.[activeId];
    if (branch?.loading) {
      // The panel itself is the busy region; the skeleton stays decorative.
      return (
        <div
          aria-busy="true"
          aria-live="polite"
          className="flex flex-col gap-3 py-4"
          data-testid={`branch-skeleton-${activeId}`}
        >
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-full" count={3} />
        </div>
      );
    }
    return branch?.content ?? null;
  };

  return (
    // The Contribute button is fixed to the viewport thumb-zone (outside the
    // scrollable panel), so this wrapper needs no positioning context — just the
    // column layout for the tab bar and its panel.
    <div className={cn('flex flex-col', className)}>
      <Tabs
        tabs={tabs}
        label={t('thread.branches.label', 'Thread branches')}
        defaultValue={defaultBranch}
        onValueChange={(id) => {
          if (isBranchId(id)) onBranchChange?.(id);
        }}
      >
        {(activeId) => <div className="py-4">{renderPanel(activeId)}</div>}
      </Tabs>

      {onContribute ? (
        // Fixed positioning lives on this wrapper, NOT the Button: the shared
        // Button base hardcodes `position: relative`, and `cn` does not resolve
        // Tailwind conflicts, so `fixed` on the Button loses to that `relative`
        // (the CTA would stay in flow and shift over branch content). A plain div
        // has no competing position, so `fixed` applies. Thumb-zone CTA, lifted
        // clear of the fixed bottom nav (~4.5rem + safe-area) and horizontally
        // CENTERED (inset-x-0 + w-fit + mx-auto); at lg the nav is a side rail, so
        // a small inset suffices. Centering is symmetric — RTL-safe, no end flip.
        <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-sticky mx-auto w-fit lg:bottom-6">
          <Button
            variant="primary"
            size="lg"
            onClick={onContribute}
            aria-label={t('thread.contribute', 'Contribute to this thread')}
            className="shadow-lg"
          >
            <Icon name="pencil" className="size-5" />
            {t('thread.contribute.short', 'Contribute')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
