// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UgcBody tests (WS-G.4.2b/c): markdown renders through the full pipeline
// (formatting preserved, hostile markup inert), safe links open in a new
// tab, and suspicious links get the wallet-drainer interstitial showing the
// FULL URL with continue/back.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLinkSafetyCacheForTests, warmLinkSafety } from '../../lib/link-safety.js';
import { UgcBody } from './UgcBody.js';

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
  vi.stubGlobal('open', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UgcBody rendering (WS-G.4.2b)', () => {
  it('renders markdown formatting through the pipeline', () => {
    const { container } = render(<UgcBody markdown={'# Title\n\n**bold** statement'} />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('keeps hostile markup inert (stored-XSS render half)', () => {
    const { container } = render(
      <UgcBody markdown={'<script>alert(1)</script><img src=x onerror=alert(1)>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders links with rel=noopener noreferrer', () => {
    const { container } = render(<UgcBody markdown={'[docs](https://example.org/a)'} />);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('UgcBody interaction branches', () => {
  it('activates links via keyboard Enter (delegated)', async () => {
    const user = userEvent.setup();
    render(<UgcBody markdown={'[news](https://news.example/kbd)'} />);
    const link = screen.getByRole('link', { name: 'news' });
    link.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.open).toHaveBeenCalled());
  });

  it('lets mailto links pass through untouched', async () => {
    const user = userEvent.setup();
    render(<UgcBody markdown={'[mail](mailto:tips@example.org)'} />);
    await user.click(screen.getByRole('link', { name: 'mail' }));
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByText(/may interact with your wallet/i)).not.toBeInTheDocument();
  });
});

describe('UgcBody link safety (WS-G.4.2c)', () => {
  it('opens safe links without an interstitial, severing the opener', async () => {
    const openedWindow = { opener: 'parent' } as unknown as Window;
    vi.stubGlobal('open', vi.fn().mockReturnValue(openedWindow));
    const user = userEvent.setup();
    render(<UgcBody markdown={'[news](https://news.example/story)'} />);
    await user.click(screen.getByRole('link', { name: 'news' }));
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith('https://news.example/story', '_blank'),
    );
    // The opener is nulled on the returned proxy (the noopener feature
    // string is NOT used — per spec it would return null even on success,
    // making popup blocking undetectable).
    expect(openedWindow.opener).toBeNull();
    expect(screen.queryByText(/may interact with your wallet/i)).not.toBeInTheDocument();
  });

  it('interposes the interstitial for a blocklisted domain, showing the full URL', async () => {
    mockBlocklist(['drainer.example']);
    await warmLinkSafety(); // the bootstrap warm-up — click verdicts never await the network
    const user = userEvent.setup();
    render(<UgcBody markdown={'[free mint](https://drainer.example/claim)'} />);
    await user.click(screen.getByRole('link', { name: 'free mint' }));
    expect(await screen.findByText(/may interact with your wallet/i)).toBeInTheDocument();
    expect(screen.getByText('https://drainer.example/claim')).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
    // Back closes without navigating.
    await user.click(screen.getByRole('button', { name: /go back/i }));
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByText(/may interact with your wallet/i)).not.toBeInTheDocument();
  });

  it('continue proceeds to the destination after explicit confirmation', async () => {
    vi.stubGlobal('open', vi.fn().mockReturnValue({ opener: 'parent' }));
    const user = userEvent.setup();
    render(<UgcBody markdown={'[approve](https://site.example/approve?spender=0xabc)'} />);
    await user.click(screen.getByRole('link', { name: 'approve' }));
    await user.click(await screen.findByRole('button', { name: /continue to site/i }));
    expect(window.open).toHaveBeenCalledWith(
      'https://site.example/approve?spender=0xabc',
      '_blank',
    );
  });

  it('falls back to the interstitial when a popup blocker eats window.open', async () => {
    vi.stubGlobal('open', vi.fn().mockReturnValue(null)); // blocked
    const user = userEvent.setup();
    render(<UgcBody markdown={'[news](https://news.example/story)'} />);
    await user.click(screen.getByRole('link', { name: 'news' }));
    // The interstitial offers a fresh user gesture instead of failing silently.
    expect(await screen.findByText('https://news.example/story')).toBeInTheDocument();
  });
});
