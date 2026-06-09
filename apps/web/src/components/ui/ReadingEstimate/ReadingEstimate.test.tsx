// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../../i18n/index.js';
import { checkA11y } from '../../../test/axe.js';
import { ReadingEstimate } from './ReadingEstimate.js';

describe('ReadingEstimate', () => {
  it('renders a localized "N min read" label', () => {
    render(<ReadingEstimate minutes={6} />);
    expect(screen.getByText('6 min read')).toBeInTheDocument();
  });

  it('floors at one minute so a short read never shows zero minutes', () => {
    render(<ReadingEstimate minutes={0.3} />);
    expect(screen.getByText('1 min read')).toBeInTheDocument();
  });

  it('formats the number for the active locale', () => {
    render(
      <I18nProvider locale="de-DE">
        <ReadingEstimate minutes={1234} />
      </I18nProvider>,
    );
    // German groups thousands with a dot.
    expect(screen.getByText('1.234 min read')).toBeInTheDocument();
  });

  it('routes the unit copy through the pseudo-locale (end-to-end localization)', () => {
    render(
      <I18nProvider locale="en-XA">
        <ReadingEstimate minutes={5} />
      </I18nProvider>,
    );
    // The number is preserved; the unit text is accented and the string expanded.
    const node = screen.getByText(/5/);
    expect(node.textContent ?? '').toContain('5');
    expect(node.textContent ?? '').not.toContain('min read');
  });

  it('can hide the decorative icon', () => {
    const { container, rerender } = render(<ReadingEstimate minutes={3} />);
    expect(container.querySelector('svg')).not.toBeNull();
    rerender(<ReadingEstimate minutes={3} hideIcon />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ReadingEstimate minutes={4} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
