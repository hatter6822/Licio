// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T challenge policy in the correction composer: the pre-flight standing
// line (quota / cooldown / capacity), the target probe (settled, own content),
// the submit gate, and the specific create-rejection copy — the composer says
// WHY a challenge cannot be filed instead of failing generically.
import type { ChallengeStanding } from '@licio/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../lib/api.js';

const mocks = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  listDraftsForThread: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('../../offline/index.js', () => ({
  saveDraft: mocks.saveDraft,
  deleteDraft: mocks.deleteDraft,
  listDraftsForThread: mocks.listDraftsForThread,
  queue: { enqueue: mocks.enqueue },
}));

const holder = vi.hoisted(() => ({
  standing: null as ChallengeStanding | null,
  mutate: (_payload: unknown, _opts: { onError?: (e: unknown) => void }): void => undefined,
  refetch: vi.fn(),
}));

vi.mock('../../lib/queries.js', () => ({
  useCreateCommentMutation: () => ({
    mutate: (payload: unknown, opts: { onError?: (e: unknown) => void }) =>
      holder.mutate(payload, opts),
    isPending: false,
    isError: false,
  }),
  useChallengeStandingQuery: () => ({
    data: holder.standing === null ? undefined : { standing: holder.standing },
    refetch: holder.refetch,
  }),
}));

import { CorrectionComposer } from './CommentParts.js';

const STORY_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

function standing(overrides: Partial<ChallengeStanding> = {}): ChallengeStanding {
  return {
    capacity: 3,
    live_count: 1,
    available: 2,
    cooldown_until: null,
    opens_last_24h: 1,
    daily_limit_resets_at: null,
    kyc_verified: true,
    earned_tier: 0,
    qualified_wins: 0,
    adjudicated_wins: 0,
    adjudicated_losses: 0,
    win_rate_gate_passed: true,
    active_withdrawal_penalties: 0,
    can_open_now: true,
    blocked_by: null,
    policy: {
      base_capacity: 1,
      kyc_capacity_bonus: 2,
      wins_per_tier: 3,
      max_earned_tiers: 5,
      max_capacity: 4,
      max_capacity_kyc: 8,
      min_win_rate: 0.5,
      opens_per_day: 5,
      withdraw_grace_ms: 300_000,
      withdraw_cooldowns_ms: [7_200_000, 86_400_000, 259_200_000],
      withdraw_window_ms: 2_592_000_000,
      free_withdrawals_per_window: 1,
      per_opponent_win_cap: 2,
      settle_threshold: 3,
    },
    target: { challengeable: true, reason: null },
    ...overrides,
  };
}

function renderComposer() {
  return render(
    <CorrectionComposer
      storyId={STORY_ID}
      threadId={THREAD_ID}
      target={{ commentId: TARGET_ID }}
      onOpened={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

beforeEach(() => {
  mocks.saveDraft.mockResolvedValue(undefined);
  mocks.deleteDraft.mockResolvedValue(undefined);
  mocks.listDraftsForThread.mockResolvedValue([]);
  mocks.enqueue.mockResolvedValue('op-id');
  holder.standing = standing();
  holder.mutate = () => undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CorrectionComposer — challenge standing', () => {
  it('shows the free-slot line and keeps the gate open', () => {
    renderComposer();
    expect(screen.getByText('2 of 3 challenge slots free.')).toBeInTheDocument();
  });

  it('blocks a SETTLED target with the settled copy', () => {
    holder.standing = standing({ target: { challengeable: false, reason: 'settled' } });
    renderComposer();
    expect(screen.getByRole('alert').textContent).toContain('settled');
    expect(screen.getByRole('button', { name: 'Open debate' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('blocks at capacity with the slot copy', () => {
    holder.standing = standing({
      blocked_by: 'capacity',
      live_count: 3,
      available: 0,
      can_open_now: false,
      target: { challengeable: true, reason: null },
    });
    renderComposer();
    expect(screen.getByRole('alert').textContent).toContain('slot frees when a verdict lands');
    expect(screen.getByRole('button', { name: 'Open debate' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('maps a challenge-policy rejection to its specific copy (never queued)', () => {
    holder.mutate = (_payload, opts) => {
      opts.onError?.(new ApiClientError('challenge_cooldown', 'cooling down', 429));
    };
    renderComposer();
    const editor = screen.getByLabelText('Your correction');
    fireEvent.change(editor, {
      target: { value: 'Wrong figure — see [the record](https://example.gov/rec).' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open debate' }));
    expect(screen.getByRole('alert').textContent).toContain('cooldown is running');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(holder.refetch).toHaveBeenCalled();
  });
});
