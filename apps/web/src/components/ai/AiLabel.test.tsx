// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K provenance labels (DoD item 5): every AI-generated output carries a
// persistent, visible label, machine-origin labels are distinct from steward
// decisions, and the badge is accessible (never colour-only).
import { AI_PROVENANCE_LABELS, type AiProvenanceLabel } from '@licio/ai-governance';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { AiLabel, isMachineGenerated } from './AiLabel.js';

describe('AiLabel', () => {
  it.each(
    AI_PROVENANCE_LABELS as readonly AiProvenanceLabel[],
  )('renders a visible text badge for %s', (label) => {
    const { container } = render(<AiLabel label={label} />);
    // A text label is always present (colour/icon is never the sole signal).
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // An icon accompanies the text.
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders machine-generated distinctly from steward-corrected', () => {
    const { container: machine } = render(<AiLabel label="machine-generated" />);
    const { container: steward } = render(<AiLabel label="steward-corrected" />);
    expect(machine.textContent).toContain('Machine-generated');
    expect(steward.textContent).toContain('Steward-corrected');
    expect(machine.textContent).not.toEqual(steward.textContent);
  });

  it('exposes the provenance explanation to assistive tech', () => {
    const { container } = render(<AiLabel label="AI-translated" />);
    // The full explanation is rendered visually-hidden for screen readers.
    expect(screen.getByText(/original text is always available/i)).toBeInTheDocument();
    expect(container.querySelector('.sr-only')?.textContent).toContain(
      'original text is always available',
    );
  });

  it('keeps the text available to assistive tech in icon-only mode', () => {
    const { container } = render(<AiLabel label="AI-draft" iconOnly />);
    expect(container.querySelector('.sr-only')?.textContent).toContain('AI draft');
  });

  it('re-exports the machine-origin predicate', () => {
    expect(isMachineGenerated('machine-generated')).toBe(true);
    expect(isMachineGenerated('steward-corrected')).toBe(false);
  });

  it('has no axe violations', async () => {
    const { container } = render(<AiLabel label="machine-generated" />);
    await checkA11y(container);
  });
});
