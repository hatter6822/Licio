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
import {
  advancePaymentIntent,
  createPaymentIntent,
  fetchPaymentIntent,
} from '../../lib/treasury-api.js';
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
  /** The submit's client idempotency key (WS-L.3.2a): a fresh UUID per attempt,
   *  STABLE across lost-response retries of this same signed submission (so they
   *  replay the one action) and NEW when a fresh attempt assembles a new preview
   *  (so a retried intent never dedups onto a prior attempt's terminal action).
   *  It is the client's own key — the intent↔action link is `payment_intent_id`,
   *  not this, so no server-derived key convention constrains it. */
  submitKey: string;
  domain: KnomosisEip712Domain;
  message: Record<string, string>;
  preview: TransactionPreview;
  walletAccountId: string;
  address: string;
  /** Set once a WS-L preflight has succeeded for this attempt (WS-L.3.2a).  A
   *  retry after a lost submit/attach response REPLAYS the submit with this
   *  token + the stored signed payload + the stable `submitKey`, rather than
   *  re-signing and re-preflighting: the message nonce is single-use and a submit
   *  consumes it, so re-preflighting the same signed message would 409
   *  `NONCE_REUSED` before the idempotent submit-replay could recover the
   *  already-created action, stranding the intent in `signed`. */
  preflightToken?: string;
  /** The exact signed typed-data message + signature the preflight was minted
   *  over — resent verbatim on the submit replay (the server's idempotent
   *  replay returns the original result without re-validating the body). */
  signedMessage?: Record<string, string>;
  signedSignature?: string;
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
  /** The intent this flow has already advanced `quoted → signed`.  The machine
   *  has no `signed → signed` edge, and a resumed attempt (a disclosure
   *  published after the preview went up) would otherwise re-run it and 409. */
  const signedRef = useRef<string | null>(null);
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
      // RESUME from where this intent actually is, rather than replaying steps
      // it has already taken.  A high-value deposit is held at preflight (the
      // review flags it, and the compliance hold bars `quoted`), so the user
      // comes back to a `preflighted` intent once a reviewer releases it — and
      // the lifecycle has no `preflighted → preflighted` edge, so replaying the
      // step 409s and a reviewed deposit could never resume.
      const state = created.existing
        ? (await fetchPaymentIntent(roomId, created.payment_intent_id)).execution_state
        : 'created';
      if (state === 'created') {
        await advancePaymentIntent(roomId, created.payment_intent_id, 'preflight');
      }
      // Only advance what is not already done — every step is a one-way edge,
      // so replaying one 409s.  An already-`quoted` intent keeps its stored
      // quote; the preview falls back to the market-rate line rather than
      // inventing a figure, because the fee rides the quote RESPONSE and this
      // path has no call to return it.
      const quoted =
        state === 'created' || state === 'preflighted'
          ? await advancePaymentIntent(roomId, created.payment_intent_id, 'quote')
          : null;
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
      const quote = quoted?.quote as { estimated_fee?: unknown } | null | undefined;
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
        submitKey: crypto.randomUUID(),
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
      // A RETRY after a submit that may already have reached the server must NOT
      // re-sign + re-preflight: the message nonce is single-use, a submit consumes
      // it, and re-preflighting the same signed message 409s `NONCE_REUSED` BEFORE
      // the idempotent submit-replay (keyed by `submitKey`) could recover the
      // already-created action — stranding the intent in `signed` until background
      // recovery/expiry.  So once a preflight has succeeded we STORE its token +
      // the signed payload and, on re-entry, replay the submit directly.
      let creds: { token: string; message: Record<string, string>; signature: string } | null =
        pending.preflightToken !== undefined &&
        pending.signedMessage !== undefined &&
        pending.signedSignature !== undefined
          ? {
              token: pending.preflightToken,
              message: pending.signedMessage,
              signature: pending.signedSignature,
            }
          : null;
      if (creds === null) {
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
        creds = {
          token: preflight.preflight_token,
          message: signed.message,
          signature: signed.signature,
        };
        // Persist for the retry path: a lost submit/attach response now replays
        // the submit instead of re-preflighting a spent nonce.
        const stored = creds;
        setPending((p) =>
          p === null
            ? p
            : {
                ...p,
                preflightToken: stored.token,
                signedMessage: stored.message,
                signedSignature: stored.signature,
              },
        );
      }
      // `quoted → signed`, ONCE.  The intent state machine has no `signed →
      // signed` edge (`signed: ['submitted','abandoned']`), so re-running this
      // on a resumed attempt 409s `invalid_transition` before the submit can
      // happen — and this path IS resumable: a disclosure published after the
      // preview sends the user to the acknowledgment panel and back.  The
      // client is the only party that knows it already advanced, so it
      // remembers.
      if (signedRef.current !== pending.paymentIntentId) {
        try {
          await advancePaymentIntent(roomId, pending.paymentIntentId, 'signed');
        } catch (e) {
          // The advance may have LANDED on a prior attempt whose response was
          // lost, so `signedRef` never got set; re-running it here 409s
          // `invalid_transition` (no signed→signed edge) and would strand a
          // deposit that is actually ready to submit until cancel/expiry.  If a
          // fetch confirms the intent is ALREADY `signed`, the prior advance took
          // — continue to the submit.  Any other cause (or state) rethrows.
          if (!(e instanceof ApiClientError && e.code === 'invalid_transition')) throw e;
          const current = await fetchPaymentIntent(roomId, pending.paymentIntentId);
          if (current.execution_state !== 'signed') throw e;
        }
        signedRef.current = pending.paymentIntentId;
      }
      // Submission needs fresh step-up; the gate opens the dialog + retries.
      // Capture into a const so the closure sees the narrowed non-null value.
      const submitCreds = creds;
      const submitted = await gate.guard(() =>
        submitKnomosisAction({
          preflight_token: submitCreds.token,
          // The attempt's own key (see `submitKey`): a lost attach response
          // replays THIS submission and recovers the existing action_record_id
          // instead of stranding the intent in `signed`.
          idempotency_key: pending.submitKey,
          action_type: 'treasury_deposit',
          room_id: roomId,
          deployment_id: treasury.deployment_id,
          wallet_account_id: pending.walletAccountId,
          payment_intent_id: pending.paymentIntentId,
          typed_data_message: submitCreds.message,
          signature: submitCreds.signature,
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
      signedRef.current = null;
      setPending(null);
      setAmount('');
      setBusy(false);
    } catch (e) {
      // WS-N.1.2d again — the gate is re-checked at the WS-L preflight AND at
      // submit (a token outlives a disclosure bump), so it can land HERE, after
      // the preview is up.  `pending` is kept: acknowledging returns to this
      // preview and the signature is retried, rather than stranding a signed
      // intent behind an error message with no way forward.
      if (e instanceof ApiClientError && e.code === 'disclosure_ack_required') {
        setNeedsDisclosures(true);
        setBusy(false);
        return;
      }
      fail(e, t('room.deposit.submitError', 'The deposit could not be submitted.'));
    }
  }

  if (needsDisclosures) {
    // WS-N.1.2d: read + acknowledge the region's current risk disclosures, then
    // return to whatever was in flight (the next attempt passes the server
    // gate).  This is checked BEFORE the pending preview: a disclosure
    // published after the preview went up gates the signing path too, and a
    // panel rendered only in the no-pending branch would be unreachable exactly
    // when it is needed.
    return (
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">
          {t('room.deposit.disclosures', 'Before your first contribution')}
        </h3>
        <RiskDisclosures onAcknowledged={() => setNeedsDisclosures(false)} />
      </div>
    );
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
            // Canceling ABANDONS this attempt.  The intent may already be
            // `signed` on the server (the `quoted → signed` advance succeeded but
            // submit/attach did not), and the lifecycle has no `signed → signed`
            // edge — so restarting under the SAME idempotency key would reuse that
            // signed intent and 409 (`invalid_transition`) when `signAndSubmit`
            // re-advances it, stranding the user until expiry.  Rotate the attempt
            // key (clear `attemptRef`) so the next deposit mints a FRESH intent;
            // the abandoned one lapses on its signed TTL.
            attemptRef.current = null;
            signedRef.current = null;
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
