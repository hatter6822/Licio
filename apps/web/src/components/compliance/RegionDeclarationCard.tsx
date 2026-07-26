// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1f — the region DECLARATION card (account settings).  The primary
// way a region is established: Licio never detects location (§19.1 — no
// geolocation, no network-address lookups, ever), so the user declares one,
// and real-fund features additionally require a compliance-reviewer
// VERIFICATION of that declaration (fail-closed: a pending declaration is
// never a resolution basis).  Shows the live resolution (region + basis),
// the declaration status, and declare/revoke controls.
import type { RegionResolutionResponse } from '@licio/shared';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n/index.js';
import {
  declareRegion,
  fetchRegionResolution,
  revokeRegionDeclaration,
} from '../../lib/compliance-api.js';
import { Button } from '../ui/Button/index.js';
import { Card } from '../ui/Card/index.js';
import { Input } from '../ui/Input/index.js';

const REGION_RE = /^[A-Z0-9][A-Z0-9-]{0,62}[A-Z0-9]$/;

const BASIS_COPY: Record<RegionResolutionResponse['basis'], string> = {
  verified_declaration: 'your verified declaration',
  locale_subtag: 'your locale setting (unverified)',
  unknown: 'not set — financial features stay off',
};

const STATUS_COPY: Record<string, string> = {
  pending: 'Pending verification — not yet used for real-fund features.',
  verified: 'Verified by a compliance reviewer.',
  revoked: 'Revoked.',
};

export function RegionDeclarationCard(): React.JSX.Element {
  const t = useT();
  const [resolution, setResolution] = useState<RegionResolutionResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setResolution(await fetchRegionResolution());
      setError(null);
    } catch {
      setError(t('compliance.region.load_error', 'Could not load your region settings.'));
    }
  };

  // Load once on mount (the settings page is not a hot path).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load — `refresh` is a fresh closure each render; depending on it would refetch every render.
  useEffect(() => {
    void refresh();
  }, []);

  const declare = async (): Promise<void> => {
    const region = draft.trim().toUpperCase();
    if (!REGION_RE.test(region)) {
      setError(
        t(
          'compliance.region.invalid',
          'Enter a region code like US, US-CA, or EU (2–64 letters/digits/hyphens).',
        ),
      );
      return;
    }
    setBusy(true);
    try {
      await declareRegion({ declared_region: region });
      setDraft('');
      await refresh();
    } catch {
      setError(t('compliance.region.declare_error', 'The declaration could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (): Promise<void> => {
    setBusy(true);
    try {
      await revokeRegionDeclaration();
      await refresh();
    } catch {
      setError(t('compliance.region.revoke_error', 'The declaration could not be revoked.'));
    } finally {
      setBusy(false);
    }
  };

  const declaration = resolution?.declaration ?? null;
  return (
    <Card as="section">
      <h3 className="text-sm font-semibold">
        {t('compliance.region.title', 'Region (self-declared)')}
      </h3>
      <p className="mt-1 text-sm text-ink-muted">
        {t(
          'compliance.region.privacy',
          'Licio never detects where you are — no location or network-address lookups, ever. Financial features use only the region you declare here (real funds require it to be verified).',
        )}
      </p>
      {resolution !== null ? (
        <p className="mt-2 text-sm" data-testid="region-resolution">
          {t('compliance.region.current', 'Current region: {region} — from {basis}.', {
            region: resolution.region ?? t('disabled.region.unknown', 'not set'),
            basis: t(`compliance.region.basis.${resolution.basis}`, BASIS_COPY[resolution.basis]),
          })}
        </p>
      ) : null}
      {declaration !== null && declaration.status !== 'revoked' ? (
        <div className="mt-2 text-sm" data-testid="declaration-status">
          <span className="font-medium">{declaration.declared_region}</span>{' '}
          <span className="text-ink-muted">
            {t(
              `compliance.region.status.${declaration.status}`,
              STATUS_COPY[declaration.status] ?? declaration.status,
            )}
          </span>
          {declaration.status === 'verified' ? (
            // A VERIFIED region cannot be self-revoked — the server DELETE returns
            // 409 `declaration_verified` — so offering the button would only fail
            // and bury the actionable guidance behind a generic error.  Direct the
            // member to the reviewer path (compliance revokes, then they redeclare).
            <p className="mt-2 text-ink-muted" data-testid="verified-change-hint">
              {t(
                'compliance.region.verified_change',
                'This region is verified. To change it, contact compliance — a reviewer must revoke a verified region before you can declare a new one.',
              )}
            </p>
          ) : (
            <div className="mt-2">
              <Button variant="secondary" disabled={busy} onClick={() => void revoke()}>
                {t('compliance.region.revoke', 'Revoke declaration')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void declare();
          }}
        >
          <Input
            label={t('compliance.region.input_label', 'Region code')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="US, US-CA, EU…"
            autoComplete="country"
          />
          <Button type="submit" disabled={busy || draft.trim().length < 2}>
            {t('compliance.region.declare', 'Declare region')}
          </Button>
        </form>
      )}
      {error !== null ? (
        <p role="alert" className="mt-2 text-sm text-error-on-soft">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
