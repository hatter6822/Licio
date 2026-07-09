// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T dispute badge/banner: "Challenged" while a sourced correction's debate is
// live, "Incorrect" once a correction prevailed, nothing when undisputed.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { DisputeBadge, DisputeBanner } from './DisputeBadge.js';

describe('DisputeBadge', () => {
  it('renders "Challenged" while a correction debate is live', () => {
    render(<DisputeBadge status="under_debate" />);
    expect(screen.getByText('Challenged')).toBeInTheDocument();
  });

  it('renders "Incorrect" once a correction prevailed', () => {
    render(<DisputeBadge status="incorrect" />);
    expect(screen.getByText('Incorrect')).toBeInTheDocument();
  });

  it('renders "Validated" when a challenge was raised and the content held', () => {
    render(<DisputeBadge status="validated" />);
    expect(screen.getByText('Validated')).toBeInTheDocument();
  });

  it('renders nothing when undisputed', () => {
    const { container } = render(<DisputeBadge status="none" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('DisputeBanner', () => {
  it('explains the "Challenged" state without implying it is already incorrect', () => {
    const { container } = render(<DisputeBanner status="under_debate" />);
    expect(screen.getByText('Challenged')).toBeInTheDocument();
    expect((container.textContent ?? '').toLowerCase()).not.toContain('incorrect');
  });

  it('explains the "Incorrect" state and that it is kept for the record', () => {
    render(<DisputeBanner status="incorrect" />);
    expect(screen.getByText('Incorrect')).toBeInTheDocument();
    expect(screen.getByText(/demoted and kept for the record/i)).toBeInTheDocument();
  });

  it('explains the "Validated" state as challenged and proven accurate', () => {
    render(<DisputeBanner status="validated" />);
    expect(screen.getByText('Validated')).toBeInTheDocument();
    expect(screen.getByText(/stands as accurate/i)).toBeInTheDocument();
  });

  it('renders nothing when undisputed', () => {
    const { container } = render(<DisputeBanner status="none" />);
    expect(container.firstChild).toBeNull();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<DisputeBanner status="incorrect" />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
