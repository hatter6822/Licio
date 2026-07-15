// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.3.1 — the member deposit flow over the SHIPPED WS-L signed-action
// pipeline.  Sequence: payment intent (idempotent) → server preflight (WS-N
// jurisdiction/sanctions, fail-closed) → fee quote → the WS-L.2.6
// full-disclosure preview derived from the EXACT typed data → EIP-712 wallet
// signature → WS-L action preflight + step-up-gated submit → intent
// attachment.  Amounts are exact decimal strings end to end
// (`parseHumanAmountToMinorUnits` — excess precision rejects, never rounds);
// the preview and the signed payload cannot diverge because both come from
// `buildTypedDataPayload` over the shared registry.

import {
  assembleTransactionPreview,
  formatMinorUnits,
  KNOMOSIS_ASSET_DECIMALS,
  type KnomosisEip712Domain,
  parseHumanAmountToMinorUnits,
  type RoomTreasuryWire,
  type TransactionPreview,
} from '@licio/shared';
import { useRef, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import { useKnomosisManifestQuery, useWalletsQuery } from '../../lib/queries.js';
import { advancePaymentIntent, createPaymentIntent } from '../../lib/treasury-api.js';
import { preflightKnomosisAction, submitKnomosisAction } from '../../lib/wallet-api.js';
import {
  discoverProviders,
  freshNonce,
  requestAccount,
  signatureExpiration,
  signTypedData,
} from '../../lib/wallet-signing.js';
import { RiskDisclosures } from '../compliance/index.js';
import { StepUpDialog, useStepUpGate } from '../security/StepUpDialog/index.js';
import { Button } from '../ui/Button/index.js';
import { Input } from '../ui/Input/index.js';
import { Select } from '../ui/Select/index.js';
import { TransactionPreviewCard } from '../wallet/TransactionPreview.js';

interface PendingSignature {
  paymentIntentId: string;
  domain: KnomosisEip712Domain;
  message: Record<string, string>;
  preview: TransactionPreview;
  walletAccountId: string;
  address: string;
}

export interface DepositFlowProps {
  roomId: string;
  treasury: RoomTreasuryWire;
  /** Room display name for the preview header. */
  roomName?: string;
  /** Called once the signed deposit is attached; the caller polls the intent. */
  onIntentCreated: (paymentIntentId: string) => void;
}

export function DepositFlow({
  roomId,
  treasury,
  roomName,
  onIntentCreated,
}: DepositFlowProps): React.ReactElement {
  const t = useT();
  const [asset, setAsset] = useState(treasury.accepted_assets[0] ?? '');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** WS-N.1.2d: the server requires disclosure acknowledgment first. */
  const [needsDisclosures, setNeedsDisclosures] = useState(false);
  const [pending, setPending] = useState<PendingSignature | null>(null);
  // ONE idempotency key per (asset, amount) attempt: a retry after a lost
  // create response must recover the SAME intent instead of minting a second
  // allowance-consuming one.  Editing the amount/asset starts a new attempt;
  // the key rotates only then or after a successful submit.
  const attemptRef = useRef<{ asset: string; amount: string; key: string } | null>(null);
  const wallets = useWalletsQuery(true);
  const manifest = useKnomosisManifestQuery(treasury.deployment_id);
  const gate = useStepUpGate();

  const decimals = KNOMOSIS_ASSET_DECIMALS[asset];
  const paused = treasury.pause_flags['deposits'] === true;
  const activeWallet = (wallets.data?.items ?? []).find(
    (wallet) =>
      wallet.unlink_state === 'active' &&
      (manifest.data === undefined || wallet.chain_id === manifest.data.chain_id),
  );

  function fail(e: unknown, fallback: string): void {
    setError(e instanceof ApiClientError ? e.message : fallback);
    setBusy(false);
  }

  /** Steps 1–3: intent → preflight → quote → assemble the preview. */
  async function startDeposit(): Promise<void> {
    setError(null);
    const minorUnits =
      decimals === undefined ? null : parseHumanAmountToMinorUnits(amount, decimals);
    if (minorUnits === null || manifest.data === undefined || activeWallet === undefined) {
      setError(
        activeWallet === undefined
          ? t(
              'room.deposit.noWallet',
              'Link a wallet on the right chain first (Profile → Security).',
            )
          : t('room.deposit.badAmount', 'Enter a valid amount for this asset.'),
      );
      return;
    }
    setBusy(true);
    try {
      const attempt = attemptRef.current;
      if (attempt === null || attempt.asset !== asset || attempt.amount !== minorUnits) {
        attemptRef.current = { asset, amount: minorUnits, key: crypto.randomUUID() };
      }
      const created = await createPaymentIntent(roomId, {
        target_type: 'treasury_deposit',
        target_id: treasury.treasury_id,
        asset,
        amount: minorUnits,
        idempotency_key: attemptRef.current?.key ?? crypto.randomUUID(),
      });
      await advancePaymentIntent(roomId, created.payment_intent_id, 'preflight');
      const quoted = await advancePaymentIntent(roomId, created.payment_intent_id, 'quote');
      const providers = await discoverProviders();
      const provider = providers[0];
      const address = provider ? await requestAccount(provider.provider) : null;
      if (provider === undefined || address === null) {
        setError(t('room.deposit.noProvider', 'No browser wallet is available.'));
        setBusy(false);
        return;
      }
      const domain: KnomosisEip712Domain = {
        name: 'Licio',
        version: manifest.data.eip712_domain_version,
        chainId: manifest.data.chain_id,
        verifyingContract: manifest.data.verifying_contract_address,
      };
      const message: Record<string, string> = {
        roomId,
        treasuryId: treasury.treasury_id,
        asset,
        amount: minorUnits,
        actor: address,
        nonce: freshNonce(),
        expiration: signatureExpiration(),
        deploymentId: treasury.deployment_id,
      };
      const quote = quoted.quote as { estimated_fee?: unknown } | null | undefined;
      const estimatedFee =
        typeof quote?.estimated_fee === 'string'
          ? `${decimals === undefined ? quote.estimated_fee : formatMinorUnits(quote.estimated_fee, decimals)} ${asset}`
          : t('room.deposit.feeUnknown', 'Network fee at market rate');
      const preview = assembleTransactionPreview('treasury_deposit', domain, message, {
        roomName: roomName ?? roomId,
        estimatedFee,
        reversibilityStatement: t(
          'room.deposit.reversibility',
          'Deposits are irreversible once finalized on chain.',
        ),
        timelock: null,
        jurisdictionStatus: t('room.deposit.jurisdiction', 'Checked at preflight'),
        riskLabel: 'normal',
        chainName: manifest.data.chain_name,
        relatedLink: null,
        supportContact: 'https://licio.app/help',
        displayAmount: decimals === undefined ? null : formatMinorUnits(minorUnits, decimals),
      });
      setPending({
        paymentIntentId: created.payment_intent_id,
        domain,
        message,
        preview,
        walletAccountId: activeWallet.wallet_account_id,
        address,
      });
      setBusy(false);
    } catch (e) {
      // WS-N.1.2d: the first-financial-action disclosure gate — surface the
      // acknowledgment flow instead of a bare error (the server re-checks on
      // every attempt; acknowledging clears it).
      if (e instanceof ApiClientError && e.code === 'disclosure_ack_required') {
        setNeedsDisclosures(true);
        setBusy(false);
        return;
      }
      fail(e, t('room.deposit.startError', 'Could not start the deposit.'));
    }
  }

  /** Steps 4–6: sign → WS-L preflight/submit → attach to the intent. */
  async function signAndSubmit(): Promise<void> {
    if (pending === null) return;
    setError(null);
    setBusy(true);
    try {
      const providers = await discoverProviders();
      const provider = providers[0];
      if (provider === undefined) {
        setError(t('room.deposit.noProvider', 'No browser wallet is available.'));
        setBusy(false);
        return;
      }
      const signed = await signTypedData({
        provider: provider.provider,
        address: pending.address,
        actionType: 'treasury_deposit',
        domain: pending.domain,
        message: pending.message,
      });
      if (signed === null) {
        setError(t('room.deposit.rejected', 'The wallet did not sign the deposit.'));
        setBusy(false);
        return;
      }
      const preflight = await preflightKnomosisAction({
        action_type: 'treasury_deposit',
        room_id: roomId,
        deployment_id: treasury.deployment_id,
        wallet_account_id: pending.walletAccountId,
        // This action SETTLES that intent — naming it makes both compliance
        // legs one attempt, so a high-value deposit is reviewed once and a
        // reviewer's release of the intent actually lets the deposit through
        // (WS-N.2.2c).  Unnamed, the WS-L leg would open a second review no
        // fraud-queue action could clear.
        payment_intent_id: pending.paymentIntentId,
        typed_data_message: signed.message,
        signature: signed.signature,
      });
      if (preflight.result === 'fail') {
        setError(preflight.human_message);
        setBusy(false);
        return;
      }
      await advancePaymentIntent(roomId, pending.paymentIntentId, 'signed');
      // Submission needs fresh step-up; the gate opens the dialog + retries.
      const submitted = await gate.guard(() =>
        submitKnomosisAction({
          preflight_token: preflight.preflight_token,
          // STABLE per intent: a retry after a lost attach response replays
          // the SAME submission and recovers the existing action_record_id
          // instead of stranding the intent in `signed`.
          idempotency_key: pending.paymentIntentId,
          action_type: 'treasury_deposit',
          room_id: roomId,
          deployment_id: treasury.deployment_id,
          wallet_account_id: pending.walletAccountId,
          payment_intent_id: pending.paymentIntentId,
          typed_data_message: signed.message,
          signature: signed.signature,
        }),
      );
      await advancePaymentIntent(
        roomId,
        pending.paymentIntentId,
        'signed',
        submitted.action_record_id,
      );
      onIntentCreated(pending.paymentIntentId);
      attemptRef.current = null; // the attempt completed — the next deposit is new
      setPending(null);
      setAmount('');
      setBusy(false);
    } catch (e) {
      fail(e, t('room.deposit.submitError', 'The deposit could not be submitted.'));
    }
  }

  if (pending !== null) {
    return (
      <div className="flex flex-col gap-2">
        <TransactionPreviewCard
          preview={pending.preview}
          onSign={() => void signAndSubmit()}
          onCancel={() => {
            setPending(null);
            setError(null);
          }}
          signing={busy}
        />
        {error ? (
          <p role="alert" className="text-sm text-error-fg">
            {error}
          </p>
        ) : null}
        <StepUpDialog {...gate.dialog} />
      </div>
    );
  }

  if (needsDisclosures) {
    // WS-N.1.2d: read + acknowledge the region's current risk disclosures,
    // then return to the form (the next attempt passes the server gate).
    return (
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">
          {t('room.deposit.disclosures', 'Before your first contribution')}
        </h3>
        <RiskDisclosures onAcknowledged={() => setNeedsDisclosures(false)} />
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={t('room.deposit.heading', 'Contribute to the treasury')}
      onSubmit={(event) => {
        event.preventDefault();
        void startDeposit();
      }}
    >
      <h3 className="text-sm font-medium">
        {t('room.deposit.heading', 'Contribute to the treasury')}
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t('room.deposit.asset', 'Asset')}
          value={asset}
          onValueChange={setAsset}
          options={treasury.accepted_assets.map((code) => ({ value: code, label: code }))}
          className="min-w-32"
        />
        <Input
          label={t('room.deposit.amount', 'Amount')}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          helperText={
            decimals !== undefined
              ? t('room.deposit.amount.help', 'Up to {decimals} decimal places', { decimals })
              : t('room.deposit.amount.minor', 'Minor units (no validated precision)')
          }
          className="min-w-40"
        />
        <Button type="submit" disabled={busy || paused || amount.trim() === ''}>
          {t('room.deposit.start', 'Review deposit')}
        </Button>
      </div>
      {paused ? (
        <p className="text-sm text-warning-fg">
          {t('room.deposit.paused', 'Deposits are paused by the room stewards.')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
    </form>
  );
}
