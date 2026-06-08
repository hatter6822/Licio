// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { DefinedTerm } from './DefinedTerm/index.js';
import { ExplainLikeNewLens } from './ExplainLikeNewLens/index.js';
import { ProgressiveDisclosure } from './ProgressiveDisclosure/index.js';

describe('ProgressiveDisclosure (WS-B.2.13)', () => {
  it('starts collapsed and toggles on activation, announcing state via <details>', async () => {
    const user = userEvent.setup();
    render(
      <ProgressiveDisclosure summary="How is this ranked?">
        <p>Ranking explanation</p>
      </ProgressiveDisclosure>,
    );
    const disclosure = screen.getByText('How is this ranked?').closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    await user.click(screen.getByText('How is this ranked?'));
    expect(disclosure).toHaveAttribute('open');
  });

  it('can default to open and has no axe violations', async () => {
    const { container } = render(
      <ProgressiveDisclosure summary="Why am I seeing this?" defaultOpen>
        <p>Distribution explanation</p>
      </ProgressiveDisclosure>,
    );
    expect(screen.getByText('Distribution explanation')).toBeVisible();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('DefinedTerm (WS-B.2.13)', () => {
  it('shows a plain-language definition on focus and is keyboard reachable', async () => {
    const user = userEvent.setup();
    render(
      <p>
        The <DefinedTerm term="PWAtt" definition="Participation-weighted attention" /> ranking.
      </p>,
    );
    const trigger = screen.getByRole('button', { name: 'PWAtt' });
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(await screen.findByText('Participation-weighted attention')).toBeInTheDocument();
  });
});

describe('ExplainLikeNewLens (WS-B.2.13)', () => {
  it('swaps to the plain-language summary when toggled', async () => {
    const user = userEvent.setup();
    render(
      <ExplainLikeNewLens
        original={<span>A technical summary with jargon.</span>}
        plainLanguageSummary={<span>A simple summary anyone can read.</span>}
      />,
    );
    expect(screen.getByText('A technical summary with jargon.')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Explain like I am new' }));
    expect(screen.getByText('A simple summary anyone can read.')).toBeInTheDocument();
  });

  it('disables the lens and explains when no plain-language version exists', () => {
    render(<ExplainLikeNewLens original={<span>Only a technical summary.</span>} />);
    expect(screen.getByRole('switch', { name: 'Explain like I am new' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('A plain-language version is not available here.')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ExplainLikeNewLens
        original={<span>Technical</span>}
        plainLanguageSummary={<span>Plain</span>}
      />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
