// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v0 wellbeing prompt (WS-H.6.1c): a polite, NON-BLOCKING status with
// supportive copy, a "see broader context" action, a dismiss control, and
// a clean accessibility audit.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { NarrowLoopPrompt } from './NarrowLoopPrompt.js';

describe('NarrowLoopPrompt', () => {
  it('renders as a polite status with both actions', async () => {
    const onSeeBroader = vi.fn();
    const onDismiss = vi.fn();
    render(<NarrowLoopPrompt onSeeBroader={onSeeBroader} onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /see broader context/i }));
    expect(onSeeBroader).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('copy is supportive, never accusatory', () => {
    render(<NarrowLoopPrompt onSeeBroader={() => {}} onDismiss={() => {}} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text.toLowerCase()).not.toMatch(/addict|warning|violat|blocked|restrict/);
    expect(text).toMatch(/broader context/i);
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<NarrowLoopPrompt onSeeBroader={() => {}} onDismiss={() => {}} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
