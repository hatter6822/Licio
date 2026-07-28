// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The operator-console and safety page shells.
//
// These pages are thin, but not empty: each one owns two decisions that are
// easy to get wrong and impossible to see in the component tests below them.
//
//   1. The `?tab=` sync.  A tab switch must REPLACE the history entry, and the
//      DEFAULT tab must clear the parameter rather than pin it — otherwise
//      browsing five queues buries the real back destination, and the "default"
//      URL is not the one a bookmark produces.
//   2. The back FALLBACK when the page was cold-loaded from a deep link.  It is
//      `/profile` for the operator consoles, and deliberately `/` for the
//      support page — which is reachable WITHOUT authentication, so a
//      locked-out user must not be bounced to a profile they cannot open.
//
// Both were unexercised: `routes/**` was excluded from coverage wholesale, so
// these files measured 0% and nothing noticed.
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { ComplianceConsolePage } from './compliance-console.js';
import { ModerationConsolePage } from './moderation.js';
import { NoticesPage, SupportPage } from './safety.js';

const navigate = vi.hoisted(() => vi.fn());
const searchMock = vi.hoisted(() => vi.fn((): Record<string, unknown> => ({})));
/** `useCanGoBack` false ⇒ the cold-load fallback runs, which is the branch under test. */
const canGoBack = vi.hoisted(() => vi.fn(() => false));
const historyBack = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#test">{children}</a>,
  useNavigate: () => navigate,
  useSearch: () => searchMock(),
  useCanGoBack: () => canGoBack(),
  useRouter: () => ({ history: { back: historyBack } }),
}));
vi.mock('./usePageFocus.js', () => ({ usePageFocus: vi.fn() }));

/** The consoles themselves are covered by their own suites; capture the props. */
const moderationProps = vi.hoisted(() => vi.fn());
vi.mock('../../components/moderation/ModerationConsole.js', () => ({
  ModerationConsole: (props: { tab?: string; onTabChange?: (next: string) => void }) => {
    moderationProps(props);
    return <div data-testid="moderation-console" />;
  },
}));
const complianceProps = vi.hoisted(() => vi.fn());
vi.mock('../../components/compliance/index.js', () => ({
  ComplianceConsole: (props: { tab?: string; onTabChange?: (next: string) => void }) => {
    complianceProps(props);
    return <div data-testid="compliance-console" />;
  },
}));
vi.mock('../../components/safety/SupportContact.js', () => ({
  SupportContact: () => <div data-testid="support-contact" />,
}));
vi.mock('../../components/safety/NoticeInbox.js', () => ({
  NoticeInbox: () => <div data-testid="notice-inbox" />,
}));
vi.mock('../../components/safety/SafetyRelations.js', () => ({
  SafetyRelations: () => <div data-testid="safety-relations" />,
}));

beforeEach(() => {
  navigate.mockClear();
  historyBack.mockClear();
  moderationProps.mockClear();
  complianceProps.mockClear();
  searchMock.mockReturnValue({});
  canGoBack.mockReturnValue(false);
});

describe.each([
  {
    label: 'moderation',
    Page: ModerationConsolePage,
    props: moderationProps,
    testId: 'moderation-console',
    to: '/moderation',
    defaultTab: 'queue',
  },
  {
    label: 'compliance',
    Page: ComplianceConsolePage,
    props: complianceProps,
    testId: 'compliance-console',
    to: '/compliance-console',
    defaultTab: 'cases',
  },
])('$label console page', ({ Page, props, testId, to, defaultTab }) => {
  it('passes the `?tab=` search value straight through, and omits it when absent', () => {
    render(<Page />);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    // Absent ⇒ the prop is NOT passed (so the console picks its own default),
    // rather than passed as `undefined`, which `exactOptionalPropertyTypes`
    // would make a different thing.
    expect('tab' in (props.mock.calls[0]?.[0] ?? {})).toBe(false);

    props.mockClear();
    searchMock.mockReturnValue({ tab: 'appeals' });
    render(<Page />);
    expect(props.mock.calls[0]?.[0]?.tab).toBe('appeals');
  });

  it('REPLACES the history entry on a tab switch, and clears the param for the default tab', () => {
    render(<Page />);
    const onTabChange = props.mock.calls[0]?.[0]?.onTabChange as (next: string) => void;

    onTabChange('appeals');
    expect(navigate).toHaveBeenLastCalledWith({ to, search: { tab: 'appeals' }, replace: true });

    // The default tab clears the parameter — the canonical URL for the landing
    // queue is the bare path, not `?tab=<default>`.
    onTabChange(defaultTab);
    expect(navigate).toHaveBeenLastCalledWith({ to, search: {}, replace: true });

    // Every switch replaces; none pushes.
    for (const call of navigate.mock.calls) expect(call[0]).toMatchObject({ replace: true });
  });

  it('falls back to the PROFILE when cold-loaded and back is pressed', async () => {
    const { container } = render(<Page />);
    screen.getByRole('button', { name: /back/i }).click();
    expect(navigate).toHaveBeenCalledWith({ to: '/profile', replace: true });
    expect(historyBack).not.toHaveBeenCalled();
    await checkA11y(container);
  });

  it('retraces real history when there IS somewhere to go back to', () => {
    canGoBack.mockReturnValue(true);
    render(<Page />);
    screen.getByRole('button', { name: /back/i }).click();
    expect(historyBack).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('safety pages', () => {
  it('SupportPage falls back to the FRONT PAGE — it is reachable unauthenticated', async () => {
    // A locked-out user still needs support, so the cold-load fallback must not
    // send them to a profile they cannot open.
    const { container } = render(<SupportPage />);
    expect(screen.getByTestId('support-contact')).toBeInTheDocument();
    screen.getByRole('button', { name: /back/i }).click();
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true });
    await checkA11y(container);
  });

  it('NoticesPage falls back to the profile — it is an authenticated surface', async () => {
    const { container } = render(<NoticesPage />);
    expect(screen.getByTestId('notice-inbox')).toBeInTheDocument();
    screen.getByRole('button', { name: /back/i }).click();
    expect(navigate).toHaveBeenCalledWith({ to: '/profile', replace: true });
    await checkA11y(container);
  });
});
