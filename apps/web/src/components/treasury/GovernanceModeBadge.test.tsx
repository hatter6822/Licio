// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.1c — the governance-mode indicator: every §17.4 mode has a label +
// description, changes announce politely to screen readers (the initial render
// does not), and the badge is accessible.
import { GOVERNANCE_MODES } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { GovernanceModeBadge } from './GovernanceModeBadge.js';
import { GOVERNANCE_MODE_META, governanceModeMeta } from './mode-meta.js';

describe('GovernanceModeBadge (WS-M.1.1c)', () => {
  it('labels every governance mode (exhaustive over the shared union)', () => {
    for (const mode of GOVERNANCE_MODES) {
      const meta = GOVERNANCE_MODE_META[mode];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      const { unmount } = render(<GovernanceModeBadge mode={mode} />);
      expect(screen.getByText(meta.label)).toBeInTheDocument();
      unmount();
    }
  });

  it('falls back visibly for an unknown server mode instead of crashing', () => {
    expect(governanceModeMeta('brand_new_mode').label).toBe('brand_new_mode');
    render(<GovernanceModeBadge mode="brand_new_mode" />);
    expect(screen.getByText('brand_new_mode')).toBeInTheDocument();
  });

  it('shows the plain-language description when requested', () => {
    render(<GovernanceModeBadge mode="capped_production" showDescription />);
    expect(screen.getByText(/strict per-action and per-window caps/i)).toBeInTheDocument();
  });

  it('announces a mode CHANGE politely, but not the initial render', () => {
    const { container, rerender } = render(<GovernanceModeBadge mode="simulated" />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe('');
    rerender(<GovernanceModeBadge mode="testnet" />);
    expect(live?.textContent).toMatch(/governance mode is now testnet/i);
  });

  it('is accessible', async () => {
    const { container } = render(<GovernanceModeBadge mode="mature_production" showDescription />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
