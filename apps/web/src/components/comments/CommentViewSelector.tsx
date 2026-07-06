// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.2.2 / WS-T — the ONE comment "view" control. A button (labelled by the
// active view) opens a modal Sheet holding this single-select list, so it scales
// to any number of lenses (unlike a chip row) and unifies sorting with lens
// filtering. Options are mutually exclusive:
//   • a SORT over all comments: Newest / Oldest (chronological, server-ordered) or
//     Highest participation (content-participation weight; WS-E.2.1c, never
//     applause — see comment-participation.ts); or
//   • a LENS: scope the conversation to one reading AND join it when you comment.
import type { LensPublic } from '@licio/shared';
import { cn } from '../../lib/cn.js';
import { Icon } from '../ui/Icon/index.js';

/** `newest`/`oldest`/`participation` sort the whole set; `lens:<id>` filters. */
export type CommentViewMode = 'newest' | 'oldest' | 'participation' | `lens:${string}`;

const SORT_LABELS: Readonly<Record<'newest' | 'oldest' | 'participation', string>> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  participation: 'Highest participation',
};

/** The lens id a `lens:<id>` view scopes to, or null for a sort view. */
export function lensIdOfView(view: CommentViewMode): string | null {
  return view.startsWith('lens:') ? view.slice('lens:'.length) : null;
}

/** The label shown on the control's button for the active view. */
export function viewLabel(view: CommentViewMode, roomLenses: readonly LensPublic[]): string {
  const lensId = lensIdOfView(view);
  if (lensId !== null) {
    const lens = roomLenses.find((l) => l.lens_id === lensId);
    // A stale lens id (deleted mid-session) degrades to the default sort label.
    return lens ? `Lens: ${lens.name}` : SORT_LABELS.oldest;
  }
  // `view` is one of the three sort keys here (lensIdOfView returned null).
  if (view === 'newest' || view === 'oldest' || view === 'participation') {
    return SORT_LABELS[view];
  }
  return SORT_LABELS.oldest;
}

export interface CommentViewSelectorProps {
  view: CommentViewMode;
  roomLenses: readonly LensPublic[];
  lensCounts: ReadonlyMap<string, number>;
  onSelect: (view: CommentViewMode) => void;
}

export function CommentViewSelector({
  view,
  roomLenses,
  lensCounts,
  onSelect,
}: CommentViewSelectorProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <ViewGroup label="Sort">
        {(['newest', 'oldest', 'participation'] as const).map((sort) => (
          <ViewOption
            key={sort}
            label={SORT_LABELS[sort]}
            selected={view === sort}
            onSelect={() => onSelect(sort)}
          />
        ))}
      </ViewGroup>
      {roomLenses.length >= 2 ? (
        <ViewGroup
          label="By interpretation lens"
          hint="Reading a lens also posts your comment to it. Not a vote."
        >
          {roomLenses.map((lens) => {
            const value: CommentViewMode = `lens:${lens.lens_id}`;
            return (
              <ViewOption
                key={lens.lens_id}
                label={`${lens.name} (${lensCounts.get(lens.lens_id) ?? 0})`}
                selected={view === value}
                onSelect={() => onSelect(value)}
              />
            );
          })}
        </ViewGroup>
      ) : null}
    </div>
  );
}

function ViewGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium text-ink-muted text-xs uppercase tracking-wide">{label}</p>
      {hint ? <p className="text-ink-muted text-xs">{hint}</p> : null}
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function ViewOption({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md px-3 py-2 text-start text-sm transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected ? 'font-medium text-ink' : 'text-ink-muted',
      )}
    >
      {label}
      {selected ? <Icon name="check" className="size-4 text-primary-on-soft" /> : null}
    </button>
  );
}
