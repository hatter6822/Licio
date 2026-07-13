// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Share affordance: Web Share API when available, clipboard fallback
// otherwise, and the idle button passes the accessibility audit. (The former
// §10.5 origin-context prompt was removed with the SCOI reader-warning
// surfaces.)
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { ShareStoryButton } from './ShareStoryButton.js';

const props = {
  title: 'River levels stabilize',
  url: 'https://licio.test/stories/abc',
};

function stubShare(): ReturnType<typeof vi.fn> {
  const share = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  return share;
}

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

afterEach(() => {
  Reflect.deleteProperty(navigator as object, 'share');
});

describe('ShareStoryButton', () => {
  it('shares through the Web Share API when available', async () => {
    const share = stubShare();
    render(<ShareStoryButton {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(share).toHaveBeenCalledWith({ title: props.title, text: '', url: props.url });
  });

  it('falls back to the clipboard when the Web Share API is unavailable', async () => {
    const writeText = stubClipboard();
    render(<ShareStoryButton {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(writeText).toHaveBeenCalledWith(props.url);
    expect(await screen.findByText('Link copied to clipboard.')).toBeInTheDocument();
  });

  it('a cancelled native sheet returns to idle without an error state', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    render(<ShareStoryButton {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(share).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Link copied to clipboard.')).not.toBeInTheDocument();
    // The button stays usable after a cancel.
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(share).toHaveBeenCalledTimes(2);
  });

  it('passes the accessibility audit', async () => {
    stubShare();
    const { container } = render(<ShareStoryButton {...props} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
