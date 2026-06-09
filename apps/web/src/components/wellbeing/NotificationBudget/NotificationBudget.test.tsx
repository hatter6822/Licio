// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../../i18n/index.js';
import { checkA11y } from '../../../test/axe.js';
import { NotificationBudget } from './NotificationBudget.js';

describe('NotificationBudget (WS-B.2.8c)', () => {
  it('renders a native determinate progressbar with an accessible name', () => {
    const { container } = render(<NotificationBudget used={3} limit={10} />);
    const progress = container.querySelector('progress');
    expect(progress).not.toBeNull();
    expect(progress).toHaveAttribute('max', '10');
    expect(progress).toHaveAttribute('value', '3');
    // The bar is named, so it is announced as a labelled progressbar.
    expect(progress).toHaveAccessibleName('Notification budget');
  });

  it('shows a visible text equivalent so colour is never the only signal (day)', () => {
    render(<NotificationBudget used={3} limit={10} period="day" />);
    expect(screen.getByText('3 of 10 notifications today')).toBeInTheDocument();
  });

  it('shows the weekly text equivalent when period="week"', () => {
    render(<NotificationBudget used={12} limit={20} period="week" />);
    expect(screen.getByText('12 of 20 notifications this week')).toBeInTheDocument();
  });

  it('surfaces a text marker (not just colour) when the budget is reached', () => {
    render(<NotificationBudget used={10} limit={10} />);
    expect(screen.getByText('Budget reached')).toBeInTheDocument();
  });

  it('clamps the progress value when bookkeeping overshoots the limit', () => {
    const { container } = render(<NotificationBudget used={14} limit={10} />);
    const progress = container.querySelector('progress');
    // value never exceeds max (a valid determinate <progress>) …
    expect(progress).toHaveAttribute('value', '10');
    // … while the visible copy still reports the true figures.
    expect(screen.getByText('14 of 10 notifications today')).toBeInTheDocument();
  });

  it('formats numbers for the active locale', () => {
    render(
      <I18nProvider locale="de-DE">
        <NotificationBudget used={1234} limit={5000} period="week" />
      </I18nProvider>,
    );
    // de-DE groups thousands with a dot.
    expect(screen.getByText('1.234 of 5.000 notifications this week')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<NotificationBudget used={3} limit={10} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
