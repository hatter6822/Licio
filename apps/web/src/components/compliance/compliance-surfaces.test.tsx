// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N web surfaces over a mocked BFF client:
//   • RegionDeclarationCard — the §19.1 never-detected promise in the copy,
//     the declare (pending, fail-closed) flow, invalid-code validation;
//   • RiskDisclosures — list + acknowledge + the acknowledged state;
//   • ComplianceConsole — the 403 access notice (server-side authorization),
//     the queues render, release/reject actions;
// plus axe on each surface.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../lib/api.js';
import * as complianceApi from '../../lib/compliance-api.js';
import { checkA11y } from '../../test/axe.js';
import { ComplianceConsole } from './ComplianceConsole.js';
import { RegionDeclarationCard } from './RegionDeclarationCard.js';
import { RiskDisclosures } from './RiskDisclosures.js';

vi.mock('../../lib/compliance-api.js');

const mocked = vi.mocked(complianceApi);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('RegionDeclarationCard (WS-N.1.1f)', () => {
  it('shows the resolution, promises no detection, and declares a region (pending)', async () => {
    mocked.fetchRegionResolution
      .mockResolvedValueOnce({ region: 'GB', basis: 'locale_subtag', declaration: null })
      .mockResolvedValueOnce({
        region: 'GB',
        basis: 'locale_subtag',
        declaration: {
          declared_region: 'DE',
          status: 'pending',
          verification_level: 'unverified',
          verified_at: null,
          created_at: '2026-07-15T00:00:00.000Z',
        },
      });
    mocked.declareRegion.mockResolvedValue({
      declaration: {
        declared_region: 'DE',
        status: 'pending',
        verification_level: 'unverified',
        verified_at: null,
        created_at: '2026-07-15T00:00:00.000Z',
      },
    });
    const { container } = render(<RegionDeclarationCard />);
    await waitFor(() => expect(screen.getByTestId('region-resolution')).toBeInTheDocument());
    // The §19.1 promise is user-visible copy, not just a code comment.
    expect(screen.getByText(/never detects where you are/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/region code/i), 'de');
    await userEvent.click(screen.getByRole('button', { name: /declare region/i }));
    await waitFor(() =>
      expect(mocked.declareRegion).toHaveBeenCalledWith({ declared_region: 'DE' }),
    );
    await waitFor(() => expect(screen.getByTestId('declaration-status')).toBeInTheDocument());
    expect(screen.getByText(/pending verification/i)).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('rejects a malformed region code client-side (server still validates)', async () => {
    mocked.fetchRegionResolution.mockResolvedValue({
      region: null,
      basis: 'unknown',
      declaration: null,
    });
    render(<RegionDeclarationCard />);
    await waitFor(() => expect(screen.getByTestId('region-resolution')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/region code/i), '-x');
    await userEvent.click(screen.getByRole('button', { name: /declare region/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/region code like/i);
    expect(mocked.declareRegion).not.toHaveBeenCalled();
  });
});

describe('RiskDisclosures (WS-N.1.2d)', () => {
  const disclosure = {
    disclosure_id: 'risk-general',
    region: 'DE',
    version: 2,
    locale: 'en',
    title: 'Risk disclosure',
    content_md: 'On-chain transactions are irreversible. Crypto is optional.',
    requires_acknowledgment: true,
    published_at: '2026-07-01T00:00:00.000Z',
    acknowledged: false,
  };

  it('lists, acknowledges, and reflects the acknowledged state', async () => {
    mocked.fetchDisclosures
      .mockResolvedValueOnce({ disclosures: [disclosure] })
      .mockResolvedValueOnce({ disclosures: [{ ...disclosure, acknowledged: true }] });
    mocked.acknowledgeDisclosure.mockResolvedValue({ acknowledged: true, remaining: [] });
    const onAcknowledged = vi.fn();
    const { container } = render(<RiskDisclosures onAcknowledged={onAcknowledged} />);
    expect(await screen.findByText('Risk disclosure')).toBeInTheDocument();
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /read and understood/i }));
    await waitFor(() =>
      expect(mocked.acknowledgeDisclosure).toHaveBeenCalledWith('risk-general', 2),
    );
    expect(await screen.findByTestId('acknowledged')).toBeInTheDocument();
    expect(onAcknowledged).toHaveBeenCalled();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('renders the empty state when no disclosures apply', async () => {
    mocked.fetchDisclosures.mockResolvedValue({ disclosures: [] });
    render(<RiskDisclosures />);
    expect(await screen.findByTestId('no-disclosures')).toBeInTheDocument();
  });
});

describe('ComplianceConsole (WS-N.2.1c / WS-N.2.2c)', () => {
  it('shows the access notice on 403 — authorization is server-side', async () => {
    mocked.adminListCases.mockRejectedValue(new ApiClientError('forbidden', 'nope', 403));
    mocked.adminFetchFraudQueue.mockRejectedValue(new ApiClientError('forbidden', 'nope', 403));
    render(<ComplianceConsole />);
    expect(await screen.findByText(/compliance access required/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('renders the queues and releases a held intent', async () => {
    const record = {
      case_id: '11111111-1111-4111-8111-111111111111',
      user_id_or_room_id: 'user-1',
      subject_kind: 'user' as const,
      trigger_type: 'pattern' as const,
      risk_level: 'medium' as const,
      partner_case_ref: null,
      review_state: 'open' as const,
      assigned_to: null,
      resolution: null,
      retention_policy: {
        retention_period_days: 730,
        deletion_date: '2028-07-15T00:00:00.000Z',
        legal_hold: false,
      },
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z',
    };
    mocked.adminListCases.mockResolvedValue({ cases: [record] });
    mocked.adminFetchFraudQueue.mockResolvedValue({
      items: [
        {
          case: record,
          payment_intent_id: '22222222-2222-4222-8222-222222222222',
          payment_compliance_state: 'flagged',
          sla_due_at: '2026-07-15T04:00:00.000Z',
        },
      ],
    });
    mocked.adminReviewIntent.mockResolvedValue({
      payment_intent_id: '22222222-2222-4222-8222-222222222222',
      compliance_state: 'cleared',
    });
    const { container } = render(<ComplianceConsole />);
    expect(await screen.findByRole('tab', { name: /fraud queue/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /fraud queue/i }));
    expect(await screen.findByText(/sla due/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^release$/i }));
    await waitFor(() =>
      expect(mocked.adminReviewIntent).toHaveBeenCalledWith(
        'release',
        '22222222-2222-4222-8222-222222222222',
        expect.any(String),
      ),
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
