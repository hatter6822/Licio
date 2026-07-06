// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.3c — the steward settings surface: a public room locks the join model
// to open (coherence); the public⇄private cascade is a confirmed action,
// separate from the plain settings write.
import type { RoomDetail } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { RoomSettingsForm } from './RoomSettingsForm.js';

const updateSettings = vi.hoisted(() => vi.fn());
const changeVisibility = vi.hoisted(() => vi.fn());
const createLens = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries.js', () => ({
  useUpdateRoomSettingsMutation: () => ({ mutate: updateSettings, isPending: false }),
  useChangeRoomVisibilityMutation: () => ({ mutate: changeVisibility, isPending: false }),
  useRoomLensesQuery: () => ({ data: [] }),
  useCreateLensMutation: () => ({ mutate: createLens, isPending: false, isError: false }),
}));

function room(over: Partial<RoomDetail>): RoomDetail {
  return {
    room_id: 'r1',
    name: 'Hydrology',
    slug: 'hydrology',
    room_type: 'global_topic',
    visibility: 'public',
    join_model: 'open',
    posting_policy: 'all_members',
    description: null,
    thread_count: 0,
    member_count: 1,
    latest_activity_at: null,
    governance_mode: 'ordinary',
    joined: true,
    created_at: '2026-01-01T00:00:00.000Z',
    lenses: [],
    stewards: [],
    governance: null,
    charter_summary: null,
    join_pending: false,
    can_post: true,
    is_steward: true,
    ...over,
  };
}

afterEach(() => {
  updateSettings.mockReset();
  changeVisibility.mockReset();
});

describe('RoomSettingsForm (WS-Q.5.3c)', () => {
  it('locks the join model for a public room and saves a coherent settings write', async () => {
    const user = userEvent.setup();
    render(<RoomSettingsForm roomId="r1" room={room({ visibility: 'public' })} />);
    expect(screen.getByRole('combobox', { name: /how members join/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(updateSettings).toHaveBeenCalledWith({
      join_model: 'open',
      posting_policy: 'all_members',
    });
  });

  it('runs the public→private cascade only after confirmation', async () => {
    const user = userEvent.setup();
    render(<RoomSettingsForm roomId="r1" room={room({ visibility: 'public' })} />);
    await user.click(screen.getByRole('button', { name: /make room private/i }));
    expect(changeVisibility).not.toHaveBeenCalled(); // confirmation required first
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    expect(changeVisibility).toHaveBeenCalledWith('private');
  });

  it('offers make-public for a private room and allows a non-open join model', () => {
    render(
      <RoomSettingsForm
        roomId="r1"
        room={room({ visibility: 'private', join_model: 'request_approval' })}
      />,
    );
    expect(screen.getByRole('combobox', { name: /how members join/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /make room public/i })).toBeInTheDocument();
  });

  it('has no accessibility violations (public + private)', async () => {
    for (const visibility of ['public', 'private'] as const) {
      const { container, unmount } = render(
        <RoomSettingsForm roomId="r1" room={room({ visibility })} />,
      );
      expect(await checkA11y(container)).toHaveNoViolations();
      unmount();
    }
  });
});
