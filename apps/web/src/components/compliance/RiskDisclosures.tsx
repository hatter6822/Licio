// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.2d — the consumer risk-disclosure acknowledgment flow.  Renders the
// region's published, versioned disclosures (counsel-authored legal
// artifacts) and records the audited acknowledgment the server REQUIRES
// before the first financial action (the intent-create gate returns
// `disclosure_ack_required` until every current version is acknowledged; a
// NEW version re-prompts).  Content renders as plain text paragraphs (no
// HTML path exists here) — disclosures are counsel-authored legal copy,
// never UGC.
import type { DisclosureListResponse } from '@licio/shared';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { acknowledgeDisclosure, fetchDisclosures } from '../../lib/compliance-api.js';
import { Button } from '../ui/Button/index.js';
import { Card } from '../ui/Card/index.js';

export interface RiskDisclosuresProps {
  /** Called after an acknowledgment lands (the caller can retry its action). */
  onAcknowledged?: (() => void) | undefined;
}

export function RiskDisclosures({ onAcknowledged }: RiskDisclosuresProps): React.JSX.Element {
  const t = useT();
  const [disclosures, setDisclosures] = useState<DisclosureListResponse['disclosures'] | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setDisclosures((await fetchDisclosures()).disclosures);
      setError(null);
    } catch {
      setError(t('compliance.disclosures.load_error', 'Could not load the risk disclosures.'));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load — `refresh` is a fresh closure each render; depending on it would refetch every render.
  useEffect(() => {
    void refresh();
  }, []);

  const acknowledge = async (disclosureId: string, version: number): Promise<void> => {
    setBusyId(disclosureId);
    try {
      const { remaining } = await acknowledgeDisclosure(disclosureId, version);
      await refresh();
      // Hand control back ONLY once every required disclosure is acknowledged.
      // A region with more than one required disclosure would otherwise send the
      // user back to the preview after the first ack, straight into
      // `disclosure_ack_required` again — clearing them one bounce at a time.
      if (remaining.length === 0) onAcknowledged?.();
    } catch {
      setError(t('compliance.disclosures.ack_error', 'The acknowledgment could not be recorded.'));
    } finally {
      setBusyId(null);
    }
  };

  if (disclosures === null) {
    return (
      <Card as="section">
        <p className="text-sm text-ink-muted">
          {t('compliance.disclosures.loading', 'Loading risk disclosures…')}
        </p>
      </Card>
    );
  }
  if (disclosures.length === 0) {
    return (
      <Card as="section">
        <p className="text-sm text-ink-muted" data-testid="no-disclosures">
          {t(
            'compliance.disclosures.none',
            'No risk disclosures apply to your declared region yet.',
          )}
        </p>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {disclosures.map((disclosure) => (
        <Card as="section" key={`${disclosure.disclosure_id}:${disclosure.version}`}>
          <h3 className="text-sm font-semibold">{disclosure.title}</h3>
          <p className="mt-1 text-xs text-ink-muted">
            {t('compliance.disclosures.meta', 'Version {version} — {region}', {
              version: disclosure.version,
              region: disclosure.region,
            })}
          </p>
          <div className="mt-2 whitespace-pre-wrap text-sm">{disclosure.content_md}</div>
          {disclosure.requires_acknowledgment ? (
            disclosure.acknowledged ? (
              <p className="mt-2 text-sm text-ink-muted" data-testid="acknowledged">
                {t('compliance.disclosures.acknowledged', 'Acknowledged.')}
              </p>
            ) : (
              <Button
                className="mt-2"
                disabled={busyId !== null}
                onClick={() => void acknowledge(disclosure.disclosure_id, disclosure.version)}
              >
                {t('compliance.disclosures.acknowledge', 'I have read and understood this')}
              </Button>
            )
          ) : null}
        </Card>
      ))}
      {error !== null ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
