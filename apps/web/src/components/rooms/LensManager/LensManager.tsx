// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.2.2 — steward lens management. A lens is an interpretation CONTEXT within
// a room (e.g. "Local resident", "Skeptical"), never a faction, ranking, or vote.
// Members tag their comments with a lens; the story page then shows WHERE those
// readings diverge (SCOI, WS-H.4). Creating a lens is steward-only — the server
// enforces the role; this surface is rendered only inside the steward settings.
import { LENS_TYPES, type LensType } from '@licio/shared';
import { useState } from 'react';
import { useCreateLensMutation, useRoomLensesQuery } from '../../../lib/queries.js';
import { Button } from '../../ui/Button/index.js';
import { Input } from '../../ui/Input/index.js';
import { Select } from '../../ui/Select/index.js';

/** Human labels for the fixed lens-type taxonomy (WS-A). */
const LENS_TYPE_LABELS: Record<LensType, string> = {
  local_resident: 'Local resident',
  beginner: 'Beginner',
  expert: 'Expert',
  affected_community: 'Affected community',
  skeptical: 'Skeptical',
  policy: 'Policy',
  historical: 'Historical',
};

export interface LensManagerProps {
  roomId: string;
}

export function LensManager({ roomId }: LensManagerProps): React.ReactElement {
  const lenses = useRoomLensesQuery(roomId);
  const create = useCreateLensMutation(roomId);
  const [name, setName] = useState('');
  const [lensType, setLensType] = useState<LensType | null>(null);
  const [description, setDescription] = useState('');

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && lensType !== null && !create.isPending;

  const submit = (): void => {
    if (!canSubmit || lensType === null) return;
    const trimmedDescription = description.trim();
    create.mutate(
      {
        name: trimmedName,
        lens_type: lensType,
        ...(trimmedDescription.length > 0 ? { description: trimmedDescription } : {}),
      },
      {
        onSuccess: () => {
          setName('');
          setLensType(null);
          setDescription('');
        },
      },
    );
  };

  const existing = lenses.data ?? [];

  return (
    <section
      aria-label="Interpretation lenses"
      className="flex flex-col gap-3 border-line border-t pt-3"
    >
      <div>
        <h3 className="font-medium text-ink text-sm">Interpretation lenses</h3>
        <p className="text-ink-muted text-sm">
          Lenses let members mark which perspective they are reading through, so the story can show
          where communities interpret it differently. They are not factions or votes.
        </p>
      </div>

      {existing.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {existing.map((lens) => (
            <li
              key={lens.lens_id}
              className="flex items-baseline justify-between gap-2 rounded border border-line px-3 py-2 text-sm"
            >
              <span className="font-medium text-ink">{lens.name}</span>
              <span className="text-ink-muted text-xs uppercase tracking-wide">
                {LENS_TYPE_LABELS[lens.lens_type]}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted text-sm">
          No lenses yet. Add one to enable the reading filter.
        </p>
      )}

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          label="Lens name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="e.g. Local resident"
        />
        <Select
          label="Lens type"
          value={lensType ?? ''}
          onValueChange={(value) => setLensType(value === '' ? null : (value as LensType))}
          placeholder="Choose a type"
          options={LENS_TYPES.map((type) => ({ value: type, label: LENS_TYPE_LABELS[type] }))}
        />
        <Input
          label="Description (optional)"
          value={description}
          maxLength={1000}
          onChange={(event) => setDescription(event.currentTarget.value)}
          placeholder="What perspective does this lens represent?"
        />
        <Button type="submit" variant="secondary" loading={create.isPending} disabled={!canSubmit}>
          Add lens
        </Button>
        {create.isError ? (
          <p role="alert" className="text-error text-sm">
            The lens could not be added. A room can have only one lens of each type.
          </p>
        ) : null}
      </form>
    </section>
  );
}
