// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.6a-d — the full-disclosure transaction preview (SPEC §17.8).  This is
// the user's last line of defence before signing: every field shown here is
// DERIVED from the exact typed-data message that will be signed (via the
// shared `assembleTransactionPreview`), so display and signed payload cannot
// diverge.  UX constraints (WS-L.2.6c): the primary button states the exact
// outcome, the cancel button is equally prominent, there is no countdown /
// scarcity / hidden fee, and no auto-advance.  Accessibility (WS-L.2.6d):
// fields announce in logical order; the risk label announces with urgency.

import type { TransactionPreview } from '@licio/shared';
import type React from 'react';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button/index.js';
import { Icon } from '../ui/Icon/index.js';

export interface TransactionPreviewProps {
  preview: TransactionPreview;
  /** Disabled until any high-value step-up completes (WS-L.2.6e). */
  signDisabled?: boolean;
  /** Reason shown when signing is disabled (e.g. re-auth required). */
  signDisabledReason?: string;
  onSign: () => void;
  onCancel: () => void;
  signing?: boolean;
}

const RISK_TONE: Record<TransactionPreview['risk_label'], { className: string; label: string }> = {
  normal: { className: 'text-ink-muted', label: 'Normal risk' },
  elevated: { className: 'text-warning-on-soft', label: 'Elevated risk' },
  high: { className: 'text-error-on-soft', label: 'High risk' },
};

function Field({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="break-words text-sm text-ink">{value}</dd>
    </div>
  );
}

export function TransactionPreviewCard({
  preview,
  signDisabled = false,
  signDisabledReason,
  onSign,
  onCancel,
  signing = false,
}: TransactionPreviewProps): React.ReactElement {
  const t = useT();
  const risk = RISK_TONE[preview.risk_label];

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-line bg-canvas p-4 neu-raised"
      aria-label={t('wallet.preview.title', 'Review before signing')}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-ink">{preview.action_name}</h2>
        <p className="text-sm text-ink-muted">
          {preview.room_name}
          {preview.amount !== null && preview.asset !== null
            ? ` · ${preview.amount} ${preview.asset}`
            : ''}
        </p>
      </header>

      {/* Risk label — announced with urgency (WS-L.2.6d). */}
      <p className={`flex items-center gap-2 text-sm font-medium ${risk.className}`} role="status">
        <Icon name={preview.risk_label === 'high' ? 'triangle-exclamation' : 'circle-info'} />
        <span>{t(`wallet.risk.${preview.risk_label}`, risk.label)}</span>
      </p>

      <dl className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        <Field
          label={t('wallet.preview.recipient', 'Recipient / contract')}
          value={preview.recipient_or_contract}
        />
        {preview.amount !== null && preview.asset !== null ? (
          <Field
            label={t('wallet.preview.amount', 'Amount')}
            value={`${preview.amount} ${preview.asset}`}
          />
        ) : null}
        <Field
          label={t('wallet.preview.fee', 'Estimated network fee')}
          value={preview.estimated_fee}
        />
        {preview.timelock !== null ? (
          <Field
            label={t('wallet.preview.timelock', 'Timelock / challenge period')}
            value={preview.timelock}
          />
        ) : null}
        <Field
          label={t('wallet.preview.wallet', 'Wallet')}
          value={preview.wallet_address_truncated}
        />
        <Field
          label={t('wallet.preview.chain', 'Chain')}
          value={`${preview.chain_name} (${preview.chain_id})`}
        />
        <Field
          label={t('wallet.preview.contract', 'Contract domain')}
          value={preview.contract_domain}
        />
        <Field
          label={t('wallet.preview.jurisdiction', 'Availability')}
          value={preview.jurisdiction_status}
        />
        <Field
          label={t('wallet.preview.expiration', 'Signature expires')}
          value={preview.expiration}
        />
        <Field label={t('wallet.preview.nonce', 'Nonce')} value={preview.nonce} />
      </dl>

      {/* WS-L.2.6a/b — AUTHORITATIVE anti-bait-and-switch disclosure: EVERY signed
          field, verbatim, with its plain-language label, derived directly from the
          typed-data message.  The friendly summary above is a curated subset; this
          guarantees the critical target of actions whose signed payload is NOT a
          recipient/amount pair (proposal_sign.proposalId, charter_update.contentHash/
          charterVersionId, steward_rotation.incoming/outgoingUserId) is shown before
          the signature is enabled.  Iterate ONLY signed_fields so display ⊆ signed. */}
      {preview.signed_fields.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-sunken p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {t('wallet.preview.signedFields', 'Exactly what you will sign')}
          </h3>
          <dl className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {preview.signed_fields.map((field) => (
              <Field key={field.name} label={field.label} value={field.value} />
            ))}
          </dl>
        </div>
      ) : null}

      {/* §19.5 durability disclosure — always shown for on-chain actions. */}
      <p className="rounded-md border border-line bg-surface-sunken p-3 text-xs text-ink-muted">
        {preview.public_visibility_disclosure}
      </p>
      <p className="text-sm text-ink-muted">{preview.reversibility_statement}</p>

      {preview.related_link !== null ? (
        <a href={preview.related_link} className="text-sm text-focus underline">
          {t('wallet.preview.related', 'View the related proposal or bounty')}
        </a>
      ) : null}

      {signDisabled && signDisabledReason !== undefined ? (
        <p className="text-sm text-warning-on-soft" role="status">
          {signDisabledReason}
        </p>
      ) : null}

      {/* Cancel is EQUALLY prominent (same size, not greyed) — WS-L.2.6c. */}
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button
          variant="primary"
          size="lg"
          className="w-full sm:flex-1"
          onClick={onSign}
          disabled={signDisabled}
          loading={signing}
        >
          {preview.primary_button_label}
        </Button>
        <Button variant="secondary" size="lg" className="w-full sm:flex-1" onClick={onCancel}>
          {t('wallet.preview.cancel', 'Cancel')}
        </Button>
      </div>

      <p className="text-xs text-ink-muted">
        {t('wallet.preview.support', 'Need help? Contact')} {preview.support_contact}
      </p>
    </section>
  );
}
