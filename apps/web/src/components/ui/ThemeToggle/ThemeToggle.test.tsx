// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { type ColorScheme, ThemeToggle, applyColorScheme } from './ThemeToggle.js';

function Harness() {
  const [scheme, setScheme] = useState<ColorScheme>('system');
  return <ThemeToggle value={scheme} onValueChange={setScheme} />;
}

describe('ThemeToggle (WS-B.1.1a manual toggle)', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('offers System / Light / Dark as an accessible radio group', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Colour theme' })).toBeInTheDocument();
    for (const name of ['System', 'Light', 'Dark']) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    }
  });

  it('applies the chosen scheme to <html data-theme> and clears it for System', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // System → no override (media query governs).
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('applyColorScheme is a usable standalone helper', () => {
    applyColorScheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyColorScheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('has no axe violations', async () => {
    const { container } = render(<Harness />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
