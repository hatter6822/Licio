// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { RestrictedState } from './RestrictedState.js';

describe('RestrictedState', () => {
  it('renders the title as a heading', () => {
    render(<RestrictedState title="Governance is unavailable" reason="Not yet enabled." />);
    expect(screen.getByRole('heading', { name: 'Governance is unavailable' })).toBeInTheDocument();
  });

  it('renders the reason text', () => {
    render(
      <RestrictedState
        title="Governance is unavailable"
        reason="Governance features are not yet enabled."
      />,
    );
    expect(screen.getByText('Governance features are not yet enabled.')).toBeInTheDocument();
  });

  it('exposes a named region labelled by its heading', () => {
    render(<RestrictedState title="Locked feature" reason="Not available to you." />);
    expect(screen.getByRole('region', { name: 'Locked feature' })).toBeInTheDocument();
  });

  it('renders no call-to-action button (never misleads)', () => {
    render(<RestrictedState title="Locked feature" reason="Not available to you." />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders the circle-info icon as decorative', () => {
    const { container } = render(<RestrictedState title="Locked" reason="Disabled." />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('respects a custom heading level', () => {
    render(<RestrictedState title="Locked" reason="Disabled." headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Locked' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <RestrictedState
        title="Governance is unavailable"
        reason="Governance features are not yet enabled."
      />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
