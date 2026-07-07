// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.1b + WS-L.2.5 — the wallet management surface: EIP-6963 provider
// discovery + connect, the SIWE link flow (build → sign → verify server-side),
// the linked-wallet list (labels, truncated addresses, risk state, unlink),
// and the empty state.  Provider `name`/`icon`/`rdns` are attacker-controllable
// display data — trust is established ONLY by server-side SIWE verification
// (WS-L.2.1a security note); nothing here implies a provider is verified.

import type { WalletSummary } from '@licio/shared';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n/index.js';
import {
  useLinkWalletMutation,
  useUnlinkWalletMutation,
  useWalletsQuery,
} from '../../lib/queries.js';
import { requestWalletNonce } from '../../lib/wallet-api.js';
import { startProviderDiscovery } from '../../wallet/discovery.js';
import type { Eip6963ProviderDetail } from '../../wallet/eip1193.js';
import { buildSiweMessage, normalizeAddress } from '../../wallet/siwe.js';
import { Button } from '../ui/Button/index.js';
import { Icon } from '../ui/Icon/index.js';

/** Ask the connected provider for its accounts + chain id (EIP-1193). */
async function connectProvider(
  detail: Eip6963ProviderDetail,
): Promise<{ address: string; chainId: number } | null> {
  try {
    const accounts = (await detail.provider.request({ method: 'eth_requestAccounts' })) as unknown;
    const chainHex = (await detail.provider.request({ method: 'eth_chainId' })) as unknown;
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') return null;
    const chainId = typeof chainHex === 'string' ? Number.parseInt(chainHex, 16) : Number(chainHex);
    if (!Number.isFinite(chainId)) return null;
    return { address: accounts[0], chainId };
  } catch {
    return null;
  }
}

export interface WalletManagerProps {
  /** Whether the crypto flag is enabled (the caller gates the whole page). */
  enabled: boolean;
}

export function WalletManager({ enabled }: WalletManagerProps): React.ReactElement {
  const t = useT();
  const [providers, setProviders] = useState<readonly Eip6963ProviderDetail[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busyRdns, setBusyRdns] = useState<string | null>(null);
  const walletsQuery = useWalletsQuery(enabled);
  const linkMutation = useLinkWalletMutation();
  const unlinkMutation = useUnlinkWalletMutation();

  useEffect(() => {
    if (!enabled) return;
    // Torn down on unmount / when the flag flips off (WS-L.2.1a).
    return startProviderDiscovery(setProviders);
  }, [enabled]);

  const linkFlow = useCallback(
    async (detail: Eip6963ProviderDetail) => {
      setBusyRdns(detail.info.rdns);
      setStatus(null);
      try {
        const connection = await connectProvider(detail);
        if (connection === null) {
          setStatus(t('wallet.connect.failed', 'Could not connect to that wallet.'));
          return;
        }
        const nonce = await requestWalletNonce();
        const message = buildSiweMessage({
          address: connection.address,
          chainId: connection.chainId,
          nonce: nonce.nonce,
        });
        // The EXACT message the user sees is the string passed to personal_sign.
        const signature = (await detail.provider.request({
          method: 'personal_sign',
          params: [message, normalizeAddress(connection.address)],
        })) as unknown;
        if (typeof signature !== 'string') {
          setStatus(t('wallet.sign.failed', 'The wallet did not return a signature.'));
          return;
        }
        await linkMutation.mutateAsync({ message, signature });
        setStatus(t('wallet.link.success', 'Wallet linked.'));
      } catch (error) {
        setStatus(
          error instanceof Error && error.message
            ? error.message
            : t('wallet.link.error', 'Could not link the wallet.'),
        );
      } finally {
        setBusyRdns(null);
      }
    },
    [linkMutation, t],
  );

  const wallets = useMemo(() => walletsQuery.data?.items ?? [], [walletsQuery.data]);

  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t('wallet.providers.title', 'Connect a wallet')}>
        <h2 className="mb-2 text-base font-semibold text-ink">
          {t('wallet.providers.title', 'Connect a wallet')}
        </h2>
        <p className="mb-3 text-sm text-ink-muted">
          {t(
            'wallet.optional.note',
            'Linking a wallet is optional and never affects your ranking or reach.',
          )}
        </p>
        {providers.length === 0 ? (
          <p className="rounded-md border border-line bg-surface-sunken p-3 text-sm text-ink-muted">
            {t(
              'wallet.providers.empty',
              'No wallet extension was found. Install a wallet extension to connect.',
            )}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {providers.map((detail) => (
              <li key={detail.info.rdns}>
                <button
                  type="button"
                  className="flex w-full min-h-12 items-center gap-3 rounded-lg border border-line bg-canvas p-3 text-left neu-raised transition-shadow active:neu-pressed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  onClick={() => void linkFlow(detail)}
                  disabled={busyRdns !== null}
                  aria-busy={busyRdns === detail.info.rdns}
                >
                  {/* Icon is extension-injected data — rendered via <img>, never innerHTML. */}
                  <img
                    src={detail.info.icon}
                    alt=""
                    aria-hidden="true"
                    className="h-8 w-8 rounded"
                  />
                  <span className="flex-1 text-sm text-ink">{detail.info.name}</span>
                  <Icon name="chevron-right" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {status !== null ? (
          <p className="mt-2 text-sm text-ink-muted" role="status">
            {status}
          </p>
        ) : null}
      </section>

      <section aria-label={t('wallet.linked.title', 'Linked wallets')}>
        <h2 className="mb-2 text-base font-semibold text-ink">
          {t('wallet.linked.title', 'Linked wallets')}
        </h2>
        {wallets.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {t('wallet.linked.empty', 'You have not linked any wallets yet.')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {wallets.map((w: WalletSummary) => (
              <li
                key={w.wallet_account_id}
                className="flex items-center gap-3 rounded-lg border border-line bg-canvas p-3 neu-raised"
              >
                <Icon name="layers" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-ink">{w.label}</p>
                  <p className="text-xs text-ink-muted">
                    {w.address_truncated} · {t(`wallet.risk.${w.risk_state}`, w.risk_state)}
                  </p>
                </div>
                {w.unlink_state === 'active' ? (
                  <Button
                    variant="ghost"
                    onClick={() => void unlinkMutation.mutateAsync(w.wallet_account_id)}
                    loading={unlinkMutation.isPending}
                  >
                    {t('wallet.unlink', 'Unlink')}
                  </Button>
                ) : (
                  <span className="text-xs text-ink-muted">
                    {t('wallet.unlink.pending', 'Unlink pending')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
