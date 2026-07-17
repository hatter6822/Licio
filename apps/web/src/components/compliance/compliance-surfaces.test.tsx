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

  it('withholds onAcknowledged until EVERY required disclosure is acknowledged', async () => {
    const second = {
      ...disclosure,
      disclosure_id: 'risk-crypto',
      version: 1,
      title: 'Crypto risk',
    };
    mocked.fetchDisclosures
      .mockResolvedValueOnce({ disclosures: [disclosure, second] })
      .mockResolvedValueOnce({ disclosures: [{ ...disclosure, acknowledged: true }, second] })
      .mockResolvedValueOnce({
        disclosures: [
          { ...disclosure, acknowledged: true },
          { ...second, acknowledged: true },
        ],
      });
    // The server reports one still outstanding after the first ack, none after the second.
    mocked.acknowledgeDisclosure
      .mockResolvedValueOnce({ acknowledged: true, remaining: [{ id: 'risk-crypto', version: 1 }] })
      .mockResolvedValueOnce({ acknowledged: true, remaining: [] });
    const onAcknowledged = vi.fn();
    render(<RiskDisclosures onAcknowledged={onAcknowledged} />);
    const buttons = await screen.findAllByRole('button', { name: /read and understood/i });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0] as HTMLElement);
    // One disclosure still requires ack → the flow stays open, parent NOT called.
    await waitFor(() => expect(mocked.acknowledgeDisclosure).toHaveBeenCalledTimes(1));
    expect(onAcknowledged).not.toHaveBeenCalled();
    // Acknowledge the remaining one → nothing outstanding → parent IS called.
    await userEvent.click(await screen.findByRole('button', { name: /read and understood/i }));
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalled());
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
        legal_hold_refs: [],
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

describe('ComplianceConsole — the case queue state machine + error paths', () => {
  const baseCase = {
    case_id: '11111111-1111-4111-8111-111111111111',
    user_id_or_room_id: 'user-1',
    subject_kind: 'user' as const,
    trigger_type: 'velocity' as const,
    risk_level: 'medium' as const,
    partner_case_ref: null,
    assigned_to: null,
    resolution: null,
    retention_policy: {
      retention_period_days: 730,
      deletion_date: '2028-07-15T00:00:00.000Z',
      legal_hold: false,
      legal_hold_refs: [],
    },
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
  };
  const caseIn = (review_state: 'open' | 'assigned' | 'investigating' | 'escalated') => ({
    ...baseCase,
    review_state,
  });

  it('offers ONLY the actions the server-side state machine permits, per state', async () => {
    // One case per state; each card exposes exactly its legal transitions.
    mocked.adminListCases.mockResolvedValue({
      cases: [
        { ...caseIn('open'), case_id: '11111111-1111-4111-8111-111111111111' },
        { ...caseIn('assigned'), case_id: '22222222-2222-4222-8222-222222222222' },
        { ...caseIn('investigating'), case_id: '33333333-3333-4333-8333-333333333333' },
      ],
    });
    mocked.adminFetchFraudQueue.mockResolvedValue({ items: [] });
    render(<ComplianceConsole />);
    // open → assign only; assigned → begin only; investigating → resolve + escalate.
    expect(await screen.findByRole('button', { name: /^assign$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /begin investigation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resolve: cleared/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^escalate$/i })).toBeInTheDocument();
  });

  it('gates assign on an assignee and resolve on notes (no empty-payload calls)', async () => {
    mocked.adminListCases.mockResolvedValue({
      cases: [
        caseIn('open'),
        { ...caseIn('investigating'), case_id: '44444444-4444-4444-8444-444444444444' },
      ],
    });
    mocked.adminFetchFraudQueue.mockResolvedValue({ items: [] });
    mocked.adminAssignCase.mockResolvedValue(caseIn('assigned'));
    mocked.adminResolveCase.mockResolvedValue({
      ...caseIn('investigating'),
      review_state: 'resolved' as never,
    });
    render(<ComplianceConsole />);
    // Gated until the operator supplies the required field. The house Button
    // marks inactivity with aria-disabled (it stays focusable + announced) and
    // swallows the click, so assert BOTH the state and that it cannot fire.
    const assignButton = await screen.findByRole('button', { name: /^assign$/i });
    expect(assignButton).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /resolve: cleared/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(assignButton);
    expect(mocked.adminAssignCase).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/assignee user id/i), 'reviewer-9');
    await userEvent.type(screen.getByLabelText(/resolution notes/i), 'no pattern found');
    await userEvent.click(screen.getByRole('button', { name: /^assign$/i }));
    await waitFor(() =>
      expect(mocked.adminAssignCase).toHaveBeenCalledWith(baseCase.case_id, 'reviewer-9'),
    );
    await userEvent.click(screen.getByRole('button', { name: /resolve: cleared/i }));
    await waitFor(() =>
      expect(mocked.adminResolveCase).toHaveBeenCalledWith(
        '44444444-4444-4444-8444-444444444444',
        'cleared',
        'no pattern found',
      ),
    );
  });

  it('surfaces a rejected case action as an alert without losing the queue', async () => {
    mocked.adminListCases.mockResolvedValue({ cases: [caseIn('assigned')] });
    mocked.adminFetchFraudQueue.mockResolvedValue({ items: [] });
    mocked.adminCaseAction.mockRejectedValue(
      new ApiClientError(
        'INVALID_CASE_TRANSITION',
        'A case cannot move assigned -> resolved.',
        409,
      ),
    );
    render(<ComplianceConsole />);
    await userEvent.click(await screen.findByRole('button', { name: /begin investigation/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot move/i);
    // The queue is still rendered (the failure is per-action, not fatal).
    expect(screen.getByRole('button', { name: /begin investigation/i })).toBeInTheDocument();
  });

  it('renders both empty states and a non-403 load error', async () => {
    mocked.adminListCases.mockResolvedValue({ cases: [] });
    mocked.adminFetchFraudQueue.mockResolvedValue({ items: [] });
    const { unmount } = render(<ComplianceConsole />);
    expect(await screen.findByTestId('empty-cases')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /fraud queue/i }));
    expect(await screen.findByTestId('empty-fraud')).toBeInTheDocument();
    unmount();

    // A 500 is NOT an authorization problem: the console shows an error, not
    // the access notice (which would misinform an authorized reviewer).
    vi.resetAllMocks();
    mocked.adminListCases.mockRejectedValue(new ApiClientError('server_error', 'boom', 500));
    mocked.adminFetchFraudQueue.mockRejectedValue(new ApiClientError('server_error', 'boom', 500));
    render(<ComplianceConsole />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i);
    expect(screen.queryByText(/compliance access required/i)).not.toBeInTheDocument();
  });

  it('rejects a fraud-queue review failure and shows no action for a non-flagged row', async () => {
    mocked.adminListCases.mockResolvedValue({ cases: [] });
    mocked.adminFetchFraudQueue.mockResolvedValue({
      items: [
        {
          case: caseIn('open'),
          payment_intent_id: '55555555-5555-4555-8555-555555555555',
          payment_compliance_state: 'flagged',
          sla_due_at: '2026-07-15T04:00:00.000Z',
        },
        {
          // A fraud-class CASE row (no intent): no release/reject affordance.
          case: { ...caseIn('open'), case_id: '66666666-6666-4666-8666-666666666666' },
          payment_intent_id: null,
          payment_compliance_state: null,
          sla_due_at: '2026-07-15T06:00:00.000Z',
        },
      ],
    });
    mocked.adminReviewIntent.mockRejectedValue(
      new ApiClientError('not_flagged', 'The intent is not held for review.', 409),
    );
    render(<ComplianceConsole />);
    await userEvent.click(await screen.findByRole('tab', { name: /fraud queue/i }));
    // Exactly ONE row carries the action pair (the held intent).
    expect(await screen.findAllByRole('button', { name: /^release$/i })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not held for review/i);
  });

  it('the declarations tab verifies and reports a rejected verification', async () => {
    mocked.adminListCases.mockResolvedValue({ cases: [] });
    mocked.adminFetchFraudQueue.mockResolvedValue({ items: [] });
    mocked.adminVerifyDeclaration.mockResolvedValue(undefined);
    const { container } = render(<ComplianceConsole />);
    await userEvent.click(await screen.findByRole('tab', { name: /declarations/i }));
    // The anti-circumvention framing is user-visible (no geolocation exists).
    expect(screen.getByText(/no geolocation anywhere on the platform/i)).toBeInTheDocument();
    const verifyButton = screen.getByRole('button', { name: /^verify$/i });
    expect(verifyButton).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(verifyButton);
    expect(mocked.adminVerifyDeclaration).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/user id/i), 'user-77');
    await userEvent.type(screen.getByLabelText(/review note/i), 'passport matches');
    await userEvent.click(screen.getByRole('button', { name: /^verify$/i }));
    await waitFor(() =>
      expect(mocked.adminVerifyDeclaration).toHaveBeenCalledWith(
        'user-77',
        'verify',
        'passport matches',
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/declaration verified/i);
    expect(await checkA11y(container)).toHaveNoViolations();

    // The reject path keeps the declaration pending (never a silent verify).
    mocked.adminVerifyDeclaration.mockRejectedValue(
      new ApiClientError('not_found', 'Resource not found', 404),
    );
    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/resource not found/i);

    // REVOKE is the reviewer's only path to remove a VERIFIED region (a member
    // DELETE is refused server-side); the console must expose it, or a wrong
    // verified region is stuck.  It routes the 'revoke' decision to the API.
    mocked.adminVerifyDeclaration.mockResolvedValue(undefined);
    await userEvent.click(screen.getByRole('button', { name: /revoke verified/i }));
    await waitFor(() =>
      expect(mocked.adminVerifyDeclaration).toHaveBeenCalledWith(
        'user-77',
        'revoke',
        'passport matches',
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/verified region revoked/i);
  });
});
