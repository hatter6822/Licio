// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI composer warning (WS-H.4.3c): informative (never accusatory),
// dismissible — the user can always proceed — and accessible.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { ContextWarning } from './ContextWarning.js';

describe('ContextWarning', () => {
  it('renders the §10.5 copy as a note', () => {
    render(<ContextWarning />);
    expect(screen.getByRole('note')).toHaveTextContent(/reading this differently/i);
    expect(screen.getByRole('note').textContent?.toLowerCase()).not.toMatch(
      /forbidden|banned|violation/,
    );
  });

  it('is dismissible and the user can proceed', async () => {
    render(<ContextWarning />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<ContextWarning />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
