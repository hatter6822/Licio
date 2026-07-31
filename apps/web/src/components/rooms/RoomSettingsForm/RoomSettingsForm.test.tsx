// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.3c — the steward settings surface: a public room locks the join model
// to open (coherence); the public⇄private cascade is a confirmed action,
// separate from the plain settings write.
import type { RoomDetail } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, RoomVisibilityBlockedError } from '../../../lib/api.js';
import { checkA11y } from '../../../test/axe.js';
import { RoomSettingsForm } from './RoomSettingsForm.js';

const updateSettings = vi.hoisted(() => vi.fn());
/** The SETTINGS mutation's error, so a test can drive the save-failure UI.  The
 *  mock's `mutate` forwards it to the caller's `onError`, which is how the real
 *  TanStack mutation delivers a rejection to a per-call handler. */
const settingsError = vi.hoisted(() => ({ value: undefined as unknown }));
const changeVisibility = vi.hoisted(() => vi.fn());
/** The cascade mutation's current error, so a test can drive the failure UI. */
const cascadeError = vi.hoisted(() => ({ value: undefined as unknown }));
const createLens = vi.hoisted(() => vi.fn());
// The blocked-story list renders router `Link`s; this suite renders the form
// outside a RouterProvider, so the link is stubbed to an anchor (the same
// treatment the other component suites give it).
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => <a href={`#${to}-${Object.values(params ?? {}).join('-')}`}>{children}</a>,
}));
vi.mock('../../../lib/queries.js', () => ({
  useUpdateRoomSettingsMutation: () => ({
    mutate: (patch: unknown, opts?: { onError?: (e: unknown) => void }) => {
      updateSettings(patch);
      if (settingsError.value !== undefined) opts?.onError?.(settingsError.value);
    },
    isPending: false,
  }),
  useChangeRoomVisibilityMutation: () => ({
    mutate: changeVisibility,
    isPending: false,
    error: cascadeError.value,
  }),
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
    my_lens_id: null,
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
  cascadeError.value = undefined;
  settingsError.value = undefined;
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

  it('NAMES the stories a refused cascade is blocked on', async () => {
    // The server identifies every public story a canonical-URL collision
    // refused to contain precisely so a steward can resolve each one — and
    // `normalizeError` projects failures through `apiErrorSchema`, which has no
    // room for a list, so the ids were parsed off and dropped one layer below
    // this UI.  A steward was left holding a count and no way to find what it
    // counted.
    cascadeError.value = new RoomVisibilityBlockedError('2 public stories share a link.', [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    render(<RoomSettingsForm roomId="r1" room={room({ visibility: 'public' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/2 public stories share a link/);
    expect(screen.getAllByRole('link', { name: /resolve this duplicate/i })).toHaveLength(2);
  });

  it('renders NO error banner when the cascade has not failed', async () => {
    // `error` is undefined on a mutation that has not run, and `!== null` would
    // have rendered the failure banner permanently.
    render(<RoomSettingsForm roomId="r1" room={room({ visibility: 'public' })} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('RENDERS a failed save — the KYC denial a non-staff steward actually gets', async () => {
    // The default path for a non-staff steward, not an edge case: the route runs
    // `checkGovernanceEligibility`, which fails closed.  The denial arrives with a
    // fully populated message and was being discarded — no alert at all, while the
    // Selects kept showing the steward's choice.  It read as SUCCESS.
    const user = userEvent.setup();
    settingsError.value = new ApiClientError(
      'kyc_required',
      'Room governance requires a verified identity (KYC).',
      403,
    );
    render(<RoomSettingsForm roomId="r1" room={room({ visibility: 'private' })} />);
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/verified identity/i);
  });

  it('falls back to a generic message when the failure is NOT an ApiClientError', async () => {
    // Offline, `fetch` rejects with a plain `TypeError` that never passes through
    // `normalizeError`; and a Postgres CHECK the in-memory adapter cannot emulate
    // surfaces as a 500 `internal_error`.  The fallback string is load-bearing.
    const user = userEvent.setup();
    settingsError.value = new TypeError('Failed to fetch');
    render(<RoomSettingsForm roomId="r1" room={room({ visibility: 'private' })} />);
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved/i);
  });

  it('attaches a per-FIELD message to the control that failed', async () => {
    // `apiErrorSchema.error.details` is a field-path -> message map from the
    // route's `zValidator`; `fieldErrorsFrom` keys it to the form's own controls so
    // the message lands on the input rather than in one banner for the whole form.
    const user = userEvent.setup();
    settingsError.value = new ApiClientError('invalid_request', 'Invalid request json.', 400, {
      posting_policy: 'Not a valid posting policy.',
    });
    render(<RoomSettingsForm roomId="r1" room={room({ visibility: 'private' })} />);
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    const control = await screen.findByRole('combobox', { name: /who can post/i });
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/not a valid posting policy/i)).toBeInTheDocument();
  });

  it('CLEARS a previous failure when the steward saves again', async () => {
    const user = userEvent.setup();
    settingsError.value = new ApiClientError('kyc_required', 'KYC required.', 403);
    render(<RoomSettingsForm roomId="r1" room={room({ visibility: 'private' })} />);
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    settingsError.value = undefined;
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
