// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { VirtualList } from './VirtualList.js';

const ITEM_HEIGHT = 40;
const items = Array.from({ length: 100 }, (_, i) => `Item ${i}`);

function renderList() {
  const utils = render(
    <VirtualList
      items={items}
      getKey={(item) => item}
      itemHeight={ITEM_HEIGHT}
      label="Story feed"
      className="h-[200px]"
      renderItem={(item) => <span>{item}</span>}
    />,
  );
  const viewport = screen.getByRole('list', { name: 'Story feed' });
  // jsdom has no layout; give the viewport a height and notify the component.
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 200 });
  fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
  return { ...utils, viewport };
}

describe('VirtualList (WS-B.1.5)', () => {
  it('renders only a windowed subset of a long list', () => {
    renderList();
    const rendered = screen.getAllByRole('listitem');
    expect(rendered.length).toBeLessThan(items.length);
    expect(screen.getByText('Item 0')).toBeInTheDocument();
    expect(screen.queryByText('Item 99')).toBeNull();
  });

  it('moves focus across rows with Arrow/Home/End (roving tabindex)', () => {
    renderList();
    const firstRow = screen.getAllByRole('listitem')[0] as HTMLElement;
    firstRow.focus();
    expect(firstRow).toHaveFocus();

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(screen.getByText('Item 1').closest('[role="listitem"]')).toHaveFocus();

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(screen.getByText('Item 99').closest('[role="listitem"]')).toHaveFocus();

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(screen.getByText('Item 0').closest('[role="listitem"]')).toHaveFocus();
  });

  it('retains focus on a row even after it scrolls out of the window', () => {
    const { viewport } = renderList();
    // Focus row 2.
    fireEvent.keyDown(screen.getAllByRole('listitem')[0] as HTMLElement, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    const focusedRow = screen.getByText('Item 2').closest('[role="listitem"]');
    expect(focusedRow).toHaveFocus();

    // Scroll far away with the pointer (does not move focus).
    fireEvent.scroll(viewport, { target: { scrollTop: 2000 } });

    // The focused row is still mounted (not recycled) and still focused.
    expect(screen.getByText('Item 2').closest('[role="listitem"]')).toHaveFocus();
    // …and far-away rows are now also windowed in.
    expect(screen.getByText('Item 50')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderList();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
