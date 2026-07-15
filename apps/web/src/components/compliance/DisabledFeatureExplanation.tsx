// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.2a/b/c — the disabled-feature explanation.  SPECIFIC, localizable,
// accessible: a descriptive title, the exact machine-readable reason mapped
// 1:1 from the engine's `disable_reason`, and (where the user can act) a
// next-step link to the region-declaration flow (WS-N.1.1f).  NEVER "coming
// soon" / bare "unavailable" — the §17.10 requirement.  Strings ride the
// shipped i18n layer keyed `disabled.{feature}.{reason}` with inline English
// defaults; the reason line deliberately reveals no internal compliance
// detail (a compliance hold says "under review", never case specifics).
import type { CryptoFeatureCell, FeatureDisableReason } from '@licio/shared';
import { useT } from '../../i18n/index.js';
import { Card } from '../ui/Card/index.js';

export interface DisabledFeatureExplanationProps {
  feature: CryptoFeatureCell;
  reason: FeatureDisableReason;
  /** The resolved region code, when one exists (never a detected location). */
  region?: string | undefined;
  className?: string | undefined;
}

const FEATURE_TITLES: Record<CryptoFeatureCell, string> = {
  wallet_connection: 'Wallet connection is not available',
  testnet_transactions: 'Test-network transactions are not available',
  production_payments: 'Payments are not available',
  treasury_operations: 'Treasury participation is not available',
  governance: 'Governance signing is not available',
};

const REASON_COPY: Record<FeatureDisableReason, { reason: string; nextStep: string | null }> = {
  region_unsupported: {
    reason:
      'Licio has not completed the legal review required to offer this feature in {region}. It stays off there until that review concludes — never silently on.',
    nextStep: null,
  },
  policy_missing: {
    reason:
      'No jurisdiction policy has been approved for {region} yet, so this feature is off by default (fail-closed).',
    nextStep: null,
  },
  age_restricted: {
    reason: 'Financial features require a confirmed adult account (platform policy §19.4).',
    nextStep: null,
  },
  compliance_hold: {
    reason:
      'Your account is under a compliance review. Financial features stay paused until it concludes.',
    nextStep: 'Contact support if you believe this is unexpected.',
  },
  policy_not_yet_effective: {
    reason:
      'The jurisdiction policy for {region} has been approved but is not in effect yet. This feature enables automatically on its effective date.',
    nextStep: null,
  },
  unknown_region: {
    reason:
      'Licio never detects where you are (no location or network-address lookups, ever). Without a region on your account, financial features stay off.',
    nextStep: 'Declare your region in account settings to continue.',
  },
  verification_required: {
    reason:
      'Real-fund features in {region} require a verified region declaration. Your current region comes from your locale setting, which is not verified.',
    nextStep: 'Verify your region declaration in account settings.',
  },
};

const SETTINGS_REASONS: ReadonlySet<FeatureDisableReason> = new Set([
  'unknown_region',
  'verification_required',
]);

/**
 * The WS-N.1.2a explanation card.  `role="status"` announces dynamically
 * revealed explanations to screen readers; the heading/paragraph/link
 * structure keeps a logical reading order (WS-N.1.2c).
 */
export function DisabledFeatureExplanation({
  feature,
  reason,
  region,
  className,
}: DisabledFeatureExplanationProps): React.JSX.Element {
  const t = useT();
  const regionLabel = region ?? t('disabled.region.unknown', 'your region');
  const copy = REASON_COPY[reason];
  const title = t(`disabled.${feature}.title`, FEATURE_TITLES[feature]);
  const reasonText = t(`disabled.${feature}.${reason}`, copy.reason, { region: regionLabel });
  return (
    <Card as="section" {...(className !== undefined ? { className } : {})}>
      <div role="status">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-ink-muted">{reasonText}</p>
        {copy.nextStep !== null ? (
          SETTINGS_REASONS.has(reason) ? (
            <a
              className="mt-2 inline-block text-sm underline underline-offset-2"
              href="/profile/privacy"
            >
              {t(`disabled.next_step.${reason}`, copy.nextStep)}
            </a>
          ) : (
            <p className="mt-2 text-sm">{t(`disabled.next_step.${reason}`, copy.nextStep)}</p>
          )
        ) : null}
      </div>
    </Card>
  );
}
