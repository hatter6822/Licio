// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../../../stores/index.js';
import { checkA11y } from '../../../test/axe.js';
import { SearchButton } from './SearchButton.js';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const STORY_ID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  useUIStore.getState().closeSearch();
});

describe('SearchButton (WS-F.3.1b banner affordance)', () => {
  it('is a labelled dialog trigger that opens the GLOBAL search when unscoped', async () => {
    const user = userEvent.setup();
    useUIStore.setState({ searchOpen: false, searchScope: null });
    render(<SearchButton />);
    const button = screen.getByRole('button', { name: 'Search' });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(button);
    expect(useUIStore.getState().searchOpen).toBe(true);
    expect(useUIStore.getState().searchScope).toBeNull();
  });

  it('carries a room scope — and names it, since the icon is the only other cue', async () => {
    const user = userEvent.setup();
    const scope = { kind: 'room', roomId: ROOM_ID, label: 'Hydrology' } as const;
    render(<SearchButton scope={scope} />);
    await user.click(screen.getByRole('button', { name: 'Search this room' }));
    expect(useUIStore.getState().searchScope).toEqual(scope);
  });

  it('carries a story scope', async () => {
    const user = userEvent.setup();
    const scope = { kind: 'story', storyId: STORY_ID, label: 'Reservoir levels' } as const;
    render(<SearchButton scope={scope} />);
    await user.click(screen.getByRole('button', { name: 'Search this conversation' }));
    expect(useUIStore.getState().searchScope).toEqual(scope);
  });

  it('never lets the click event reach the store as a scope', async () => {
    // `onClick={openSearch}` would pass the MouseEvent straight through as the
    // scope — a silent corruption the modal would then send to the server.
    const user = userEvent.setup();
    render(<SearchButton />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(useUIStore.getState().searchScope).toBeNull();
  });

  it('closing clears the scope, so the next global open cannot inherit it', async () => {
    const user = userEvent.setup();
    render(<SearchButton scope={{ kind: 'room', roomId: ROOM_ID, label: 'Hydrology' }} />);
    await user.click(screen.getByRole('button', { name: 'Search this room' }));
    useUIStore.getState().closeSearch();
    expect(useUIStore.getState().searchScope).toBeNull();
    // The app-wide hotkey is global by construction, whatever page it fires on.
    useUIStore.getState().toggleSearch();
    expect(useUIStore.getState().searchOpen).toBe(true);
    expect(useUIStore.getState().searchScope).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<SearchButton />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
