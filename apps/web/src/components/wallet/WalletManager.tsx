// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.1b + WS-L.2.5 — the wallet management surface: EIP-6963 provider
// discovery + connect, the SIWE link flow (build → sign → verify server-side),
// the linked-wallet list (labels, truncated addresses, risk state, unlink),
// and the empty state.  Provider `name`/`icon`/`rdns` are attacker-controllable
// display data — trust is established ONLY by server-side SIWE verification
// (WS-L.2.1a security note); nothing here implies a provider is verified.

import type { UnlinkObligation, WalletSummary } from '@licio/shared';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import { StepUpRequiredError } from '../../lib/auth-api.js';
import {
  useLinkWalletMutation,
  useUnlinkWalletMutation,
  useWalletRiskStateQuery,
  useWalletsQuery,
} from '../../lib/queries.js';
import { requestWalletNonce } from '../../lib/wallet-api.js';
import { startProviderDiscovery } from '../../wallet/discovery.js';
import type { Eip6963ProviderDetail } from '../../wallet/eip1193.js';
import { buildSiweMessage, LICIO_WALLET_CHAIN_ID, normalizeAddress } from '../../wallet/siwe.js';
import { StepUpDialog, useStepUpGate } from '../security/StepUpDialog/index.js';
import { Button } from '../ui/Button/index.js';
import { Icon } from '../ui/Icon/index.js';

/**
 * The plain-language reason a wallet is flagged, plus the next step when one
 * exists (WS-L.2.5c-1).  The list projection carries only the coarse
 * `risk_state` enum, so this fetches the per-wallet detail — lazily, and ONLY
 * for a non-normal wallet, so an ordinary wallet list still makes one request.
 * Never raw sanctions/fraud internals: the server decides what is safe to say.
 */
function WalletRiskExplanation({ walletId }: { walletId: string }): React.ReactElement | null {
  const risk = useWalletRiskStateQuery(walletId);
  if (!risk.data) return null;
  return (
    <div className="mt-1 text-xs">
      <p className="text-ink">{risk.data.explanation}</p>
      {risk.data.next_step !== null ? (
        <p className="text-ink-muted">{risk.data.next_step}</p>
      ) : null}
    </div>
  );
}

/** The provider `icon` is attacker-controllable announcement data.  Only a
 *  `data:image/...` URI is safe to put in `<img src>`; an `https://…` icon would
 *  make the browser request a third-party URL (leaking a visit to the wallet
 *  surface) whenever this page opens.  Anything else falls back to a local icon
 *  (WS-L.2.1a). */
function safeIconSrc(icon: string): string | null {
  return /^data:image\//i.test(icon.trim()) ? icon : null;
}

/** Ask the connected provider for its selected account (EIP-1193).  We do NOT read
 *  the wallet's active `eth_chainId`: the link message is bound to the Knomosis chain
 *  (`LICIO_WALLET_CHAIN_ID`) regardless of the extension's current network, so a wallet
 *  on mainnet never produces a `Chain ID: 1` link message. */
async function connectProvider(detail: Eip6963ProviderDetail): Promise<{ address: string } | null> {
  try {
    const accounts = (await detail.provider.request({ method: 'eth_requestAccounts' })) as unknown;
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') return null;
    return { address: accounts[0] };
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
  const [blockedObligations, setBlockedObligations] = useState<readonly UnlinkObligation[] | null>(
    null,
  );
  const walletsQuery = useWalletsQuery(enabled);
  const linkMutation = useLinkWalletMutation();
  const unlinkMutation = useUnlinkWalletMutation();
  // Link + unlink both require a FRESH step-up; the gate transparently opens the
  // challenge dialog and retries the SAME action once satisfied (WS-L.2.5a/b).
  const gate = useStepUpGate();

  // The GET /wallets gate returns 503 `wallet_disabled` / `crypto_disabled` when the
  // wallet_connection kill switch is engaged (or crypto is off).  Wallet discovery +
  // connect must consume THAT state, not just the page-level crypto flag, so the
  // module never starts EIP-6963 discovery or prompts `eth_requestAccounts` while
  // wallet connection is paused (WS-L.3.5a — the switch disables the wallet module
  // immediately).  `failureReason` catches a switch that engages MID-SESSION: a
  // background refetch fails 503 while TanStack retains the prior (stale) data.
  const gateError = walletsQuery.error ?? walletsQuery.failureReason;
  const walletConnectionPaused =
    gateError instanceof ApiClientError &&
    (gateError.code === 'wallet_disabled' || gateError.code === 'crypto_disabled');
  // Wait for the /wallets gate to CONFIRM availability before discovering, so a
  // page load while the switch is engaged never races a provider prompt in first.
  const walletConnectionAvailable = enabled && walletsQuery.isSuccess && !walletConnectionPaused;

  useEffect(() => {
    if (!walletConnectionAvailable) {
      // Crypto off, wallet connection paused, or availability not yet confirmed: do
      // NOT start discovery, and drop any previously-discovered providers so no
      // connect button survives into the pause to prompt a wallet (WS-L.2.1a/3.5a).
      setProviders([]);
      return;
    }
    // Torn down on unmount / when availability flips off (WS-L.2.1a).
    return startProviderDiscovery(setProviders);
  }, [walletConnectionAvailable]);

  const linkFlow = useCallback(
    async (detail: Eip6963ProviderDetail) => {
      // Defence in depth: never prompt the wallet while connection is paused, even
      // if a stale button somehow survives (WS-L.3.5a).
      if (!walletConnectionAvailable) {
        setStatus(t('wallet.paused', 'Wallet connection is temporarily disabled.'));
        return;
      }
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
          // Bind to the Knomosis chain, NOT the wallet's active network, so the signed
          // message is never scoped to mainnet (WS-L.2.3b).
          chainId: LICIO_WALLET_CHAIN_ID,
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
        // Run through the step-up gate so an expired step-up opens the retry
        // dialog instead of surfacing a bare 401 (WS-L.2.5a).
        await gate.guard(() => linkMutation.mutateAsync({ message, signature }));
        setStatus(t('wallet.link.success', 'Wallet linked.'));
      } catch (error) {
        if (error instanceof StepUpRequiredError) {
          // The user dismissed the step-up challenge — a quiet cancellation.
          setStatus(t('wallet.stepup.cancelled', 'Verification is required to link a wallet.'));
        } else {
          setStatus(
            error instanceof Error && error.message
              ? error.message
              : t('wallet.link.error', 'Could not link the wallet.'),
          );
        }
      } finally {
        setBusyRdns(null);
      }
    },
    [gate, linkMutation, t, walletConnectionAvailable],
  );

  const unlinkFlow = useCallback(
    async (walletId: string) => {
      setStatus(null);
      setBlockedObligations(null);
      try {
        const result = await gate.guard(() => unlinkMutation.mutateAsync(walletId));
        if ('error' in result) {
          // 409 blocked: SURFACE the specific obligations so the user knows what
          // to resolve first (WS-L.2.5b) — never a silent no-op.
          setBlockedObligations(result.blocking_obligations);
          const extra =
            (result.total_obligations ?? result.blocking_obligations.length) -
            result.blocking_obligations.length;
          setStatus(
            extra > 0
              ? t(
                  'wallet.unlink.blocked.more',
                  'Unlink is blocked by pending obligations (+{count} more).',
                  {
                    count: extra,
                  },
                )
              : t('wallet.unlink.blocked', 'Unlink is blocked by pending obligations.'),
          );
        } else {
          setStatus(t('wallet.unlink.scheduled', 'Unlink scheduled after the cooling-off period.'));
        }
      } catch (error) {
        if (error instanceof StepUpRequiredError) {
          setStatus(
            t('wallet.stepup.cancelled.unlink', 'Verification is required to unlink a wallet.'),
          );
        } else {
          setStatus(
            error instanceof Error && error.message
              ? error.message
              : t('wallet.unlink.error', 'Could not unlink the wallet.'),
          );
        }
      }
    },
    [gate, unlinkMutation, t],
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
        {enabled && walletConnectionPaused ? (
          <p
            role="status"
            className="rounded-md border border-line bg-surface-sunken p-3 text-sm text-ink-muted"
          >
            {t(
              'wallet.paused',
              'Wallet connection is temporarily disabled. Please try again later.',
            )}
          </p>
        ) : providers.length === 0 ? (
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
                  {/* Icon is extension-injected data — rendered via <img>, never
                      innerHTML, and ONLY when it is a data: URI (else a local
                      fallback, so no third-party request is made). */}
                  {safeIconSrc(detail.info.icon) !== null ? (
                    <img
                      src={safeIconSrc(detail.info.icon) ?? undefined}
                      alt=""
                      aria-hidden="true"
                      className="h-8 w-8 rounded"
                    />
                  ) : (
                    <span
                      className="flex h-8 w-8 items-center justify-center rounded"
                      aria-hidden="true"
                    >
                      <Icon name="layers" />
                    </span>
                  )}
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
                  {/* A non-normal risk state is a bare enum word on this row.
                      The server already computes a plain-language explanation and
                      a user-actionable next step for exactly this case
                      (WS-L.2.5c-1); showing the label without them tells the owner
                      something is wrong and nothing about what to do. */}
                  {w.risk_state !== 'normal' ? (
                    <WalletRiskExplanation walletId={w.wallet_account_id} />
                  ) : null}
                </div>
                {w.unlink_state === 'active' ? (
                  <Button
                    variant="ghost"
                    onClick={() => void unlinkFlow(w.wallet_account_id)}
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
        {blockedObligations !== null ? (
          <div
            className="mt-3 rounded-md border border-line bg-surface-sunken p-3"
            role="alert"
            aria-label={t('wallet.unlink.blocked.title', 'Unlink is blocked')}
          >
            <p className="mb-2 text-sm font-medium text-ink">
              {t('wallet.unlink.blocked.title', 'Resolve these before unlinking:')}
            </p>
            <ul className="flex flex-col gap-1">
              {blockedObligations.map((o) => (
                <li key={`${o.type}:${o.ref}`} className="text-xs text-ink-muted">
                  {o.description}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <StepUpDialog {...gate.dialog} />
    </div>
  );
}
