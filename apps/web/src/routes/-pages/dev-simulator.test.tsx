// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The DEV-only traffic-simulator page.
//
// `DevSimulatorPage` carries a production kill-branch — `if
// (!import.meta.env.DEV)` renders a "not available" notice instead of the panel
// — and nothing exercised it.  That branch is the client half of the project's
// "prod runs the real feature by default; dev may fake it, never the reverse"
// posture, so both sides of it are asserted here: a production build must not
// mount the panel, and a development build must.
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#test">{children}</a>,
  useNavigate: () => navigate,
  useCanGoBack: () => true,
  useRouter: () => ({ history: { back: vi.fn() } }),
}));

/** The panel drives a dev-only API surface; the page's own branch is the subject. */
const panelRendered = vi.hoisted(() => vi.fn());
vi.mock('../../components/dev/SimulatorPanel.js', () => ({
  SimulatorPanel: () => {
    panelRendered();
    return <div data-testid="simulator-panel" />;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  panelRendered.mockClear();
});

/** Import the page AFTER stubbing the env, so the branch reads the stub. */
async function pageWithDev(dev: boolean) {
  vi.stubEnv('DEV', dev);
  vi.resetModules();
  const { DevSimulatorPage } = await import('./dev-simulator.js');
  return DevSimulatorPage;
}

describe('DevSimulatorPage', () => {
  it('mounts the panel in a DEVELOPMENT build', async () => {
    const Page = await pageWithDev(true);
    render(<Page />);
    expect(screen.getByTestId('simulator-panel')).toBeInTheDocument();
    expect(panelRendered).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /traffic simulator/i })).toBeInTheDocument();
  });

  it('renders a NOT-AVAILABLE notice and never mounts the panel in production', async () => {
    const Page = await pageWithDev(false);
    render(<Page />);
    expect(screen.queryByTestId('simulator-panel')).not.toBeInTheDocument();
    expect(panelRendered).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /not available/i })).toBeInTheDocument();
    expect(screen.getByText(/development-only tool/i)).toBeInTheDocument();
  });

  it('has no accessibility violations in either build', async () => {
    const Dev = await pageWithDev(true);
    const { container: devContainer } = render(<Dev />);
    await checkA11y(devContainer);
    const Prod = await pageWithDev(false);
    const { container: prodContainer } = render(<Prod />);
    await checkA11y(prodContainer);
  });
});
