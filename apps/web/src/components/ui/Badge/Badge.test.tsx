// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { toneIcons } from '../status.js';
import { Badge, type BadgeTone } from './Badge.js';

const semanticTones: BadgeTone[] = ['success', 'warning', 'error', 'info'];

describe('Badge', () => {
  it.each(semanticTones)('renders the %s tone with both an icon and a text label', (tone) => {
    const { container } = render(<Badge tone={tone}>{tone}</Badge>);
    // Text label is visible (colour is never the sole differentiator).
    expect(screen.getByText(tone)).toBeInTheDocument();
    // The tone's default status icon is present.
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(toneIcons[tone as keyof typeof toneIcons]).toBeTruthy();
  });

  it('defaults to the neutral tone with no icon but keeps the label', () => {
    const { container } = render(<Badge>Draft</Badge>);
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.firstElementChild).toHaveClass('bg-surface', 'text-ink');
  });

  it('allows overriding the icon', () => {
    const { container } = render(
      <Badge tone="info" icon="bell">
        Alerts
      </Badge>,
    );
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
  });

  it('keeps the label as sr-only text in icon-only mode', () => {
    const { container } = render(
      <Badge tone="success" iconOnly>
        Verified
      </Badge>,
    );
    const badge = container.firstElementChild as HTMLElement;
    // Icon is rendered.
    expect(badge.querySelector('svg')).not.toBeNull();
    // Label is still present for assistive tech, but visually hidden.
    const label = within(badge).getByText('Verified');
    expect(label).toHaveClass('sr-only');
  });

  it('uses the soft tone classes for semantic tones', () => {
    const { container } = render(<Badge tone="error">Blocked</Badge>);
    expect(container.firstElementChild).toHaveClass('bg-error-soft', 'text-error-on-soft');
  });

  it('has no axe violations across tones and icon-only', async () => {
    const { container } = render(
      <div>
        {semanticTones.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
        <Badge>neutral</Badge>
        <Badge tone="success" iconOnly>
          Verified
        </Badge>
      </div>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
