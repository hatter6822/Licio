// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.2.2 — the room POSTING-lens picker (presentational).  A single-select
// radio list whose FIRST option is always "Undecided" (the default no-committed-
// lens state present in every room), followed by the room's interpretation
// lenses.  This is a DELIBERATE choice of the interpretation a member represents
// when they post — it is never the reading/filter lens, so a member can never
// accidentally post as a lens they were only viewing.
import { type LensPublic, UNDECIDED_LENS_LABEL } from '@licio/shared';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../../ui/Icon/index.js';

/** The human label for a posting lens id — a room lens name, or "Undecided" for
 *  the default null state (self-heals to Undecided if the id has been removed). */
export function lensDisplayName(lensId: string | null, lenses: readonly LensPublic[]): string {
  if (lensId === null) return UNDECIDED_LENS_LABEL;
  return lenses.find((lens) => lens.lens_id === lensId)?.name ?? UNDECIDED_LENS_LABEL;
}

export interface RoomLensSelectorProps {
  lenses: readonly LensPublic[];
  /** The current selection: a lens id, or null = Undecided. */
  value: string | null;
  onSelect: (lensId: string | null) => void;
  /** Disables every option while a change is in flight. */
  disabled?: boolean;
}

export function RoomLensSelector({
  lenses,
  value,
  onSelect,
  disabled = false,
}: RoomLensSelectorProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1" role="radiogroup" aria-label="Posting lens">
      <LensOption
        label={UNDECIDED_LENS_LABEL}
        description="Post without committing to a specific interpretation — you can choose a lens anytime."
        selected={value === null}
        disabled={disabled}
        onSelect={() => onSelect(null)}
      />
      {lenses.map((lens) => (
        <LensOption
          key={lens.lens_id}
          label={lens.name}
          {...(lens.description ? { description: lens.description } : {})}
          selected={value === lens.lens_id}
          disabled={disabled}
          onSelect={() => onSelect(lens.lens_id)}
        />
      ))}
    </div>
  );
}

function LensOption({
  label,
  description,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  description?: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-start justify-between gap-3 rounded-md px-3 py-2 text-start transition-colors',
        'hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:opacity-60',
        selected ? 'bg-surface' : '',
      )}
    >
      <span className="flex flex-col gap-0.5">
        <span className={cn('text-sm', selected ? 'font-medium text-ink' : 'text-ink')}>
          {label}
        </span>
        {description ? <span className="text-ink-muted text-xs">{description}</span> : null}
      </span>
      {selected ? (
        <Icon name="check" className="mt-0.5 size-4 shrink-0 text-primary-on-soft" />
      ) : null}
    </button>
  );
}
