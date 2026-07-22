// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useUIStore } from '../../../stores/index.js';
import { checkA11y } from '../../../test/axe.js';
import { SearchButton } from './SearchButton.js';

describe('SearchButton (WS-F.3.1b banner affordance)', () => {
  it('is a labelled dialog trigger that opens the search modal state', async () => {
    const user = userEvent.setup();
    useUIStore.setState({ searchOpen: false });
    render(<SearchButton />);
    const button = screen.getByRole('button', { name: 'Search' });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(button);
    expect(useUIStore.getState().searchOpen).toBe(true);
    useUIStore.setState({ searchOpen: false });
  });

  it('has no axe violations', async () => {
    const { container } = render(<SearchButton />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
