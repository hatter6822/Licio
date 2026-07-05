// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SafeExternalLink tests (WS-G.4.2c): a citation/source link rendered OUTSIDE
// the UGC sink still routes through the drainer blocklist + heuristics — a safe
// host opens in a severed-opener tab, a blocklisted host gets the interstitial,
// and a non-http scheme (doi:) is left to the browser.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLinkSafetyCacheForTests, warmLinkSafety } from '../../lib/link-safety.js';
import { SafeExternalLink } from './SafeExternalLink.js';

function mockBlocklist(domains: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ version: 'v1', domains }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

beforeEach(() => {
  resetLinkSafetyCacheForTests();
  mockBlocklist([]);
  vi.stubGlobal('open', vi.fn().mockReturnValue({ opener: 'parent' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SafeExternalLink', () => {
  it('opens a safe source link in a severed-opener tab', async () => {
    const openedWindow = { opener: 'parent' } as unknown as Window;
    vi.stubGlobal('open', vi.fn().mockReturnValue(openedWindow));
    const user = userEvent.setup();
    render(<SafeExternalLink href="https://news.example/story">a source</SafeExternalLink>);
    await user.click(screen.getByRole('link', { name: 'a source' }));
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith('https://news.example/story', '_blank'),
    );
    expect(openedWindow.opener).toBeNull();
    expect(screen.queryByText(/may interact with your wallet/i)).not.toBeInTheDocument();
  });

  it('interposes the interstitial for a blocklisted source host', async () => {
    mockBlocklist(['drainer.example']);
    await warmLinkSafety();
    const user = userEvent.setup();
    render(<SafeExternalLink href="https://drainer.example/claim">bad source</SafeExternalLink>);
    await user.click(screen.getByRole('link', { name: 'bad source' }));
    expect(await screen.findByText(/may interact with your wallet/i)).toBeInTheDocument();
    expect(screen.getByText('https://drainer.example/claim')).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /continue to site/i }));
    expect(window.open).toHaveBeenCalledWith('https://drainer.example/claim', '_blank');
  });

  it('activates via keyboard Enter', async () => {
    const user = userEvent.setup();
    render(<SafeExternalLink href="https://news.example/kbd">kbd source</SafeExternalLink>);
    screen.getByRole('link', { name: 'kbd source' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.open).toHaveBeenCalled());
  });

  it('leaves a non-http(s) scheme (doi:) to the browser', async () => {
    const user = userEvent.setup();
    render(<SafeExternalLink href="doi:10.1000/xyz">a doi</SafeExternalLink>);
    await user.click(screen.getByRole('link', { name: 'a doi' }));
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByText(/may interact with your wallet/i)).not.toBeInTheDocument();
  });

  it('falls back to the interstitial when a popup blocker eats a safe open', async () => {
    vi.stubGlobal('open', vi.fn().mockReturnValue(null)); // blocked
    const user = userEvent.setup();
    render(<SafeExternalLink href="https://news.example/story">safe source</SafeExternalLink>);
    await user.click(screen.getByRole('link', { name: 'safe source' }));
    // Offers a fresh user gesture instead of failing silently; Back then closes it.
    expect(await screen.findByText('https://news.example/story')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /go back/i }));
    expect(screen.queryByText(/may interact with your wallet/i)).not.toBeInTheDocument();
  });
});
