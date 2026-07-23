// SPDX-License-Identifier: AGPL-3.0-or-later
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { checkA11y } from '../../test/axe.js';
import { ToastProvider } from '../ui/Toast/index.js';

vi.mock('../../lib/safety-api.js', () => ({
  fetchSupportContact: vi.fn(),
  submitReport: vi.fn(),
  createBlockByHandle: vi.fn(),
  createMuteByHandle: vi.fn(),
  fetchBlocks: vi.fn(),
  fetchMutes: vi.fn(),
  removeBlock: vi.fn(),
  removeMute: vi.fn(),
}));
vi.mock('../../offline/queue.js', () => ({ enqueue: vi.fn() }));

const api = await import('../../lib/safety-api.js');
const { ReportButton, ReportSheet } = await import('./ReportSheet.js');
const { SupportContact } = await import('./SupportContact.js');
const { BlockMuteButtons, SafetyRelations } = await import('./SafetyRelations.js');

function Providers({ children }: { children: ReactNode }): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nProvider locale="en">
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

afterEach(() => vi.clearAllMocks());

describe('SupportContact', () => {
  it('renders the safety email and emergency resources with no axe violations', async () => {
    vi.mocked(api.fetchSupportContact).mockResolvedValue({
      safety_email: 'safety@licio.app',
      help_center_url: 'https://licio.app/help',
      jurisdiction: null,
      emergency_resources: [
        {
          label: 'Crisis line',
          description: 'Find help near you.',
          url: 'https://example.org',
          phone: null,
        },
      ],
    });
    const { container } = render(<SupportContact />, { wrapper: Providers });
    await waitFor(() => expect(screen.getByText('safety@licio.app')).toBeInTheDocument());
    expect(screen.getByText('Crisis line')).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('ReportSheet (two-tap)', () => {
  it('lists reasons by category and submits the selected reason', async () => {
    vi.mocked(api.submitReport).mockResolvedValue({
      report_id: '00000000-0000-4000-8000-000000000001',
      status: 'new',
      severity: 'moderate',
      routed_to: 'standard',
      created_at: new Date().toISOString(),
      idempotent: false,
    });
    const onClose = vi.fn();
    const { container } = render(
      <ReportSheet
        open
        onClose={onClose}
        targetType="content"
        targetId="00000000-0000-4000-8000-0000000000aa"
        contentKind="contribution"
      />,
      { wrapper: Providers },
    );
    // Grouped by category.
    expect(screen.getByRole('heading', { name: 'Safety' })).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
    // Two taps: the sheet is open (tap 1), tap a reason (tap 2) → submit.
    await userEvent.click(screen.getByRole('button', { name: /Harassment/ }));
    await waitFor(() => expect(api.submitReport).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.submitReport).mock.calls[0]?.[0]).toMatchObject({
      target_type: 'content',
      reason_code: 'MOD_HARASS_001',
      content_kind: 'contribution',
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ReportButton', () => {
  it('opens the sheet from a labelled text button', async () => {
    render(<ReportButton targetType="content" targetId="00000000-0000-4000-8000-0000000000aa" />, {
      wrapper: Providers,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(screen.getByRole('dialog', { name: 'Report' })).toBeInTheDocument();
  });

  it("icon-only keeps a real name (and takes the caller's), and still opens the sheet", async () => {
    const { container } = render(
      <ReportButton
        iconOnly
        label="Report this story"
        targetType="content"
        targetId="00000000-0000-4000-8000-0000000000aa"
        contentKind="story"
      />,
      { wrapper: Providers },
    );
    const button = screen.getByRole('button', { name: 'Report this story' });
    // Icon-only is a VISUAL economy: no text label, but never an unnamed control.
    expect(button.textContent).toBe('');
    expect(await checkA11y(container)).toHaveNoViolations();

    // The name is also shown sighted, on hover/focus (WCAG 1.4.13).
    button.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Report this story');

    await userEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Report' })).toBeInTheDocument();
  });
});

// WS-J.1.2 — the block/mute half of the two-tap safety affordance (SPEC §B).
// These controls address the target by PUBLIC HANDLE because that is the only
// identifier a reader holds: the public contribution projection withholds
// `author_user_id` (§19.5).
describe('BlockMuteButtons (WS-J.1.2)', () => {
  const block = {
    block_id: 'b1',
    blocked_user_id: 'u1',
    blocked_user_handle: 'noisy',
    created_at: new Date().toISOString(),
  };
  const mute = {
    mute_id: 'm1',
    muted_user_id: 'u1',
    muted_user_handle: 'noisy',
    expires_at: null,
    created_at: new Date().toISOString(),
  };

  it('blocks by handle and names the target on the control', async () => {
    vi.mocked(api.createBlockByHandle).mockResolvedValue(block);
    const onDone = vi.fn();
    const { container } = render(<BlockMuteButtons handle="noisy" onDone={onDone} />, {
      wrapper: Providers,
    });
    expect(await checkA11y(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole('button', { name: /Block @noisy/ }));
    await waitFor(() => expect(api.createBlockByHandle).toHaveBeenCalledWith('noisy'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  // The API has always accepted a mute window; the control now exposes it rather
  // than silently defaulting to "forever".
  it('mutes for the CHOSEN duration', async () => {
    vi.mocked(api.createMuteByHandle).mockResolvedValue(mute);
    render(<BlockMuteButtons handle="noisy" />, { wrapper: Providers });
    // The design-system Select is a listbox combobox, not a native <select>.
    await userEvent.click(screen.getByRole('combobox', { name: 'Mute for' }));
    await userEvent.click(screen.getByRole('option', { name: '30 days' }));
    await userEvent.click(screen.getByRole('button', { name: /Mute @noisy/ }));
    await waitFor(() => expect(api.createMuteByHandle).toHaveBeenCalledWith('noisy', '30d'));
  });

  // The server applies the relationship filter on the NEXT fetch, so the caches
  // holding already-rendered content must be dropped or the toast's "you will no
  // longer see each other" is false until an unrelated refetch.
  it('invalidates the relationship-filtered content caches on success', async () => {
    vi.mocked(api.createBlockByHandle).mockResolvedValue(block);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(
      <I18nProvider locale="en">
        <QueryClientProvider client={client}>
          <ToastProvider>
            <BlockMuteButtons handle="noisy" />
          </ToastProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Block @noisy/ }));
    await waitFor(() => expect(api.createBlockByHandle).toHaveBeenCalled());
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['blocks']));
    for (const prefix of [['feed'], ['story'], ['thread'], ['room'], ['search']]) {
      expect(keys, `missing ${prefix[0]}`).toContain(JSON.stringify(prefix));
    }
  });

  // A silent failure would leave the reader believing they had blocked someone.
  it('surfaces a failure instead of reporting success', async () => {
    vi.mocked(api.createBlockByHandle).mockRejectedValue(new Error('nope'));
    const onDone = vi.fn();
    render(<BlockMuteButtons handle="noisy" onDone={onDone} />, { wrapper: Providers });
    await userEvent.click(screen.getByRole('button', { name: /Block @noisy/ }));
    await waitFor(() =>
      expect(screen.getByText('We could not block that account.')).toBeInTheDocument(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('ReportSheet — the self-serve half', () => {
  it('offers block/mute when the author handle is known', async () => {
    render(
      <ReportSheet
        open
        onClose={vi.fn()}
        targetType="content"
        targetId="00000000-0000-4000-8000-0000000000aa"
        contentKind="contribution"
        authorHandle="noisy"
      />,
      { wrapper: Providers },
    );
    expect(screen.getByRole('button', { name: /Block @noisy/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mute @noisy/ })).toBeInTheDocument();
  });

  // No handle (a deleted-account tombstone, or the reader's own content) ⇒ no
  // control, rather than a control that cannot succeed.
  it('omits block/mute when the author is unknown', () => {
    render(
      <ReportSheet
        open
        onClose={vi.fn()}
        targetType="content"
        targetId="00000000-0000-4000-8000-0000000000aa"
        contentKind="contribution"
      />,
      { wrapper: Providers },
    );
    expect(screen.queryByRole('button', { name: /^Block/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mute/ })).not.toBeInTheDocument();
  });
});

describe('SafetyRelations', () => {
  // An unblock list keyed on truncated opaque ids is not a management surface —
  // the reader must be able to tell WHO they blocked.
  it('names blocked and muted accounts by handle', async () => {
    vi.mocked(api.fetchBlocks).mockResolvedValue({
      blocks: [
        {
          block_id: 'b1',
          blocked_user_id: 'u1',
          blocked_user_handle: 'noisy',
          created_at: new Date().toISOString(),
        },
      ], // prettier-ignore
      next_cursor: null,
    });
    vi.mocked(api.fetchMutes).mockResolvedValue({
      mutes: [
        {
          mute_id: 'm1',
          muted_user_id: 'u2',
          muted_user_handle: 'chatty',
          expires_at: null,
          created_at: new Date().toISOString(),
        },
      ], // prettier-ignore
      next_cursor: null,
    });
    const { container } = render(<SafetyRelations />, { wrapper: Providers });
    await waitFor(() => expect(screen.getByText('@noisy')).toBeInTheDocument());
    expect(screen.getByText('@chatty')).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
