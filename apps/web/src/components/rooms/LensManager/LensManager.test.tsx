// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LensPublic } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../../lib/api.js';
import { checkA11y } from '../../../test/axe.js';
import { LensManager } from './LensManager.js';

const createLens = vi.hoisted(() => vi.fn());
const lensesData = vi.hoisted(() => ({ current: [] as LensPublic[] }));
const createState = vi.hoisted(() => ({ isError: false, error: undefined as unknown }));
vi.mock('../../../lib/queries.js', () => ({
  useRoomLensesQuery: () => ({ data: lensesData.current }),
  useCreateLensMutation: () => ({
    mutate: createLens,
    isPending: false,
    isError: createState.isError,
    error: createState.error,
  }),
}));

beforeEach(() => {
  createState.isError = false;
  createState.error = undefined;
  createLens.mockClear();
});

const lens = (over: Partial<LensPublic>): LensPublic => ({
  lens_id: '11111111-1111-4111-8111-111111111111',
  room_id: 'r1',
  name: 'Skeptical lens',
  lens_type: 'skeptical',
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('LensManager (WS-G.2.2 steward lens management)', () => {
  it('shows the empty state when a room has no lenses', () => {
    lensesData.current = [];
    render(<LensManager roomId="r1" />);
    expect(screen.getByText(/no lenses yet/i)).toBeInTheDocument();
  });

  it('lists the room lenses with their type', () => {
    lensesData.current = [lens({ name: 'Riverside voices', lens_type: 'local_resident' })];
    render(<LensManager roomId="r1" />);
    expect(screen.getByText('Riverside voices')).toBeInTheDocument();
  });

  it('creates a lens with the chosen name and type', async () => {
    lensesData.current = [];
    createLens.mockClear();
    const user = userEvent.setup();
    render(<LensManager roomId="r1" />);

    await user.type(screen.getByRole('textbox', { name: /lens name/i }), 'Industry lens');
    await user.click(screen.getByRole('combobox', { name: /lens type/i }));
    await user.click(screen.getByRole('option', { name: /^policy$/i }));
    await user.click(screen.getByRole('button', { name: /add lens/i }));

    expect(createLens).toHaveBeenCalledTimes(1);
    expect(createLens.mock.calls[0]?.[0]).toMatchObject({
      name: 'Industry lens',
      lens_type: 'policy',
    });
  });

  it('disables the submit until a name and type are set', () => {
    lensesData.current = [];
    render(<LensManager roomId="r1" />);
    expect(screen.getByRole('button', { name: /add lens/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('surfaces the server reason honestly when a create fails', () => {
    lensesData.current = [];
    createState.isError = true;
    createState.error = new ApiClientError(
      'duplicate_lens',
      'This room already has a lens of that type',
      409,
    );
    render(<LensManager roomId="r1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This room already has a lens of that type',
    );
  });

  it('has no accessibility violations', async () => {
    lensesData.current = [lens({})];
    const { container } = render(<LensManager roomId="r1" />);
    await checkA11y(container);
  });
});
