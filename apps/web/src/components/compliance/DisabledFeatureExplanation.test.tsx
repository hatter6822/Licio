// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.2a/b/c — the explanation component: every (feature × reason)
// combination renders a title + a SPECIFIC reason (the no-vague-language
// gate enumerates the engine enum, so a new reason without copy fails here),
// the settings next-step link appears for the actionable reasons, the German
// catalog covers every disabled-state key (the WS-N.1.2b completeness
// requirement), and the component is accessible.
import { CRYPTO_FEATURE_CELLS, FEATURE_DISABLE_REASONS } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import deMessages from '../../i18n/catalogs/de.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { checkA11y } from '../../test/axe.js';
import { DisabledFeatureExplanation } from './DisabledFeatureExplanation.js';

// §17.10: never vague. These phrasings are FORBIDDEN as the whole explanation.
const VAGUE = /coming soon|not supported\.?$|^unavailable\.?$/i;

describe('DisabledFeatureExplanation (WS-N.1.2a)', () => {
  it('renders a title + specific reason for EVERY feature × reason (engine-enum exhaustive)', () => {
    for (const feature of CRYPTO_FEATURE_CELLS) {
      for (const reason of FEATURE_DISABLE_REASONS) {
        const { container, unmount } = render(
          <DisabledFeatureExplanation feature={feature} reason={reason} region="DE" />,
        );
        const heading = container.querySelector('h3');
        expect(heading?.textContent ?? '', `${feature}/${reason} title`).not.toBe('');
        const body = container.textContent ?? '';
        expect(body.length, `${feature}/${reason} reason`).toBeGreaterThan(40);
        expect(body, `${feature}/${reason} must not be vague`).not.toMatch(VAGUE);
        unmount();
      }
    }
  });

  it('interpolates the region and never claims to know where the user is', () => {
    render(
      <DisabledFeatureExplanation
        feature="production_payments"
        reason="region_unsupported"
        region="US-CA"
      />,
    );
    expect(screen.getByText(/US-CA/)).toBeInTheDocument();
  });

  it('links the actionable reasons to the declaration flow in settings', () => {
    for (const reason of ['unknown_region', 'verification_required'] as const) {
      const { unmount } = render(
        <DisabledFeatureExplanation feature="wallet_connection" reason={reason} />,
      );
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', '/profile/privacy');
      unmount();
    }
  });

  it('the compliance_hold copy reveals no case detail', () => {
    const { container } = render(
      <DisabledFeatureExplanation feature="treasury_operations" reason="compliance_hold" />,
    );
    const body = container.textContent ?? '';
    expect(body).toMatch(/under a compliance review/i);
    expect(body).not.toMatch(/sanction|screening|risk score|case id/i);
  });

  it('the German catalog covers every disabled-state key (WS-N.1.2b completeness)', () => {
    for (const feature of CRYPTO_FEATURE_CELLS) {
      expect(deMessages[`disabled.${feature}.title`], `de title for ${feature}`).toBeTruthy();
      for (const reason of FEATURE_DISABLE_REASONS) {
        expect(
          deMessages[`disabled.${feature}.${reason}`],
          `de copy for ${feature}/${reason}`,
        ).toBeTruthy();
      }
    }
    // And it actually renders through the provider (no raw keys in the UI).
    render(
      <I18nProvider locale="de" messages={deMessages}>
        <DisabledFeatureExplanation
          feature="production_payments"
          reason="verification_required"
          region="DE"
        />
      </I18nProvider>,
    );
    expect(screen.getByText('Zahlungen sind nicht verfügbar')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/disabled\./);
  });

  it('is accessible (dynamic reveal announces via role=status)', async () => {
    const { container } = render(
      <DisabledFeatureExplanation feature="wallet_connection" reason="unknown_region" />,
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
