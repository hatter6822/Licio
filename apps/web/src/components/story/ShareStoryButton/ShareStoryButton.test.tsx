// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Share affordance with the §10.5 origin-context prompt (WS-H.4.3c):
// context-sensitive stories prompt BEFORE sharing (include origin context /
// share as is / cancel — never blocking), ordinary stories share directly,
// the clipboard fallback covers engines without the Web Share API, and the
// prompt passes the accessibility audit.
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

describe('ShareStoryButton (WS-H.4.3c §10.5)', () => {
  it('shares ordinary stories directly without any prompt', async () => {
    const share = stubShare();
    render(<ShareStoryButton {...props} needsContext={false} />);
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(share).toHaveBeenCalledWith({ title: props.title, text: '', url: props.url });
    expect(screen.queryByText(/context-sensitive/i)).not.toBeInTheDocument();
  });

  it('prompts on context-sensitive stories; "with context" includes the origin note', async () => {
    const share = stubShare();
    render(<ShareStoryButton {...props} needsContext />);
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(
      screen.getByText('This item is context-sensitive. Include origin context?'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Share with context' }));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]?.[0]?.text).toMatch(/reading this story differently/);
  });

  it('"share as is" never blocks; cancel returns to idle without sharing', async () => {
    const share = stubShare();
    render(<ShareStoryButton {...props} needsContext />);
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(share).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Share as is' }));
    expect(share).toHaveBeenCalledWith({ title: props.title, text: '', url: props.url });
  });

  it('falls back to the clipboard when the Web Share API is unavailable', async () => {
    const writeText = stubClipboard();
    render(<ShareStoryButton {...props} needsContext={false} />);
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(writeText).toHaveBeenCalledWith(props.url);
    expect(await screen.findByText('Link copied to clipboard.')).toBeInTheDocument();
  });

  it('the prompt passes the accessibility audit', async () => {
    stubShare();
    const { container } = render(<ShareStoryButton {...props} needsContext />);
    await userEvent.click(screen.getByRole('button', { name: /share/i }));
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
