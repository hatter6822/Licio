// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.1b + WS-L.2.5 — the wallet manager: the empty provider state, the
// discovered-provider connect+SIWE link flow (REAL message build → mock
// provider sign → mock link mutation), the linked-wallet list, and axe.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';

const mockUseWallets = vi.fn();
const mockLinkMutate = vi.fn();
const mockUnlinkMutate = vi.fn();
vi.mock('../../lib/queries.js', () => ({
  useWalletsQuery: () => mockUseWallets(),
  useLinkWalletMutation: () => ({ mutateAsync: mockLinkMutate, isPending: false }),
  useUnlinkWalletMutation: () => ({ mutateAsync: mockUnlinkMutate, isPending: false }),
}));

const mockRequestNonce = vi.fn();
vi.mock('../../lib/wallet-api.js', () => ({
  requestWalletNonce: () => mockRequestNonce(),
}));

let discoveryCallback: ((providers: unknown[]) => void) | null = null;
vi.mock('../../wallet/discovery.js', () => ({
  startProviderDiscovery: (cb: (providers: unknown[]) => void) => {
    discoveryCallback = cb;
    cb([]);
    return () => {
      discoveryCallback = null;
    };
  },
}));

import { WalletManager } from './WalletManager.js';

beforeEach(() => {
  mockUseWallets.mockReset();
  mockLinkMutate.mockReset();
  mockUnlinkMutate.mockReset();
  mockRequestNonce.mockReset();
  discoveryCallback = null;
  mockUseWallets.mockReturnValue({ data: { items: [] } });
});

describe('WalletManager', () => {
  it('shows the empty provider state when no wallet is discovered', () => {
    render(<WalletManager enabled />);
    expect(screen.getByText(/no wallet extension was found/i)).toBeInTheDocument();
    expect(screen.getByText(/never affects your ranking/i)).toBeInTheDocument();
  });

  it('links a discovered wallet through the SIWE flow', async () => {
    mockRequestNonce.mockResolvedValue({
      nonce: 'abc123',
      issued_at: '2026-07-06T12:00:00.000Z',
      expires_at: '2026-07-06T12:05:00.000Z',
    });
    mockLinkMutate.mockResolvedValue({ wallet: {}, already_linked: false });

    const providerRequest = vi.fn(async (args: { method: string }) => {
      if (args.method === 'eth_requestAccounts')
        return ['0xAbC0000000000000000000000000000000000001'];
      if (args.method === 'eth_chainId') return '0x7a69'; // 31337
      if (args.method === 'personal_sign') return '0xsignature';
      return null;
    });

    render(<WalletManager enabled />);
    // Announce a provider through the mocked discovery callback.
    discoveryCallback?.([
      {
        info: { uuid: 'u', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' },
        provider: { request: providerRequest },
      },
    ]);

    const connectButton = await screen.findByRole('button', { name: /metamask/i });
    fireEvent.click(connectButton);

    await waitFor(() => expect(mockLinkMutate).toHaveBeenCalledTimes(1));
    // The signed message must be the EXACT string the wallet was asked to sign.
    const [linkArgs] = mockLinkMutate.mock.calls[0] as [{ message: string; signature: string }];
    const signCall = providerRequest.mock.calls.find((c) => c[0].method === 'personal_sign');
    expect((signCall?.[0] as unknown as { params: string[] }).params[0]).toBe(linkArgs.message);
    expect(linkArgs.signature).toBe('0xsignature');
    // The message binds Licio's domain (anti-phishing).
    expect(linkArgs.message).toContain('wants you to sign in');
  });

  it('lists linked wallets with truncated addresses and an unlink action', () => {
    mockUseWallets.mockReturnValue({
      data: {
        items: [
          {
            wallet_account_id: 'w1',
            label: 'Treasury key',
            address_truncated: '0x1234…5678',
            chain_id: 31337,
            wallet_type: 'eoa',
            unlink_state: 'active',
            risk_state: 'normal',
            linked_at: '2026-07-06T12:00:00.000Z',
            last_used_at: null,
          },
        ],
      },
    });
    mockUnlinkMutate.mockResolvedValue({
      wallet_account_id: 'w1',
      unlink_state: 'pending_unlink',
      finalize_after: '2026-07-07T12:00:00.000Z',
    });
    render(<WalletManager enabled />);
    expect(screen.getByText('Treasury key')).toBeInTheDocument();
    expect(screen.getByText(/0x1234…5678/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /unlink/i }));
    expect(mockUnlinkMutate).toHaveBeenCalledWith('w1');
  });

  it('surfaces the blocking obligations when unlink is blocked (R9-6)', async () => {
    mockUseWallets.mockReturnValue({
      data: {
        items: [
          {
            wallet_account_id: 'w1',
            label: 'Treasury key',
            address_truncated: '0x1234…5678',
            chain_id: 31337,
            wallet_type: 'eoa',
            unlink_state: 'active',
            risk_state: 'normal',
            linked_at: '2026-07-06T12:00:00.000Z',
            last_used_at: null,
          },
        ],
      },
    });
    // The server's typed 409 blocked response (not an error the mutation rejects).
    mockUnlinkMutate.mockResolvedValue({
      error: { code: 'unlink_blocked', message: 'blocked' },
      blocking_obligations: [
        { type: 'open_proposal', ref: 'p1', description: 'Open proposal awaiting your vote' },
      ],
    });
    render(<WalletManager enabled />);
    fireEvent.click(screen.getByRole('button', { name: /unlink/i }));
    // The specific obligation is shown, not a silent no-op.
    expect(await screen.findByText(/open proposal awaiting your vote/i)).toBeInTheDocument();
  });

  it('does NOT render an <img> for a non-data: wallet icon (R9-11)', async () => {
    render(<WalletManager enabled />);
    // A provider that announces an https icon (would leak a third-party request).
    discoveryCallback?.([
      {
        info: {
          uuid: 'u',
          name: 'PhishWallet',
          icon: 'https://evil.example/icon.png',
          rdns: 'com.evil',
        },
        provider: { request: vi.fn() },
      },
    ]);
    await screen.findByRole('button', { name: /phishwallet/i });
    // No image element sources the announced https URL.
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) expect(img.getAttribute('src')).not.toContain('evil.example');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<WalletManager enabled />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
