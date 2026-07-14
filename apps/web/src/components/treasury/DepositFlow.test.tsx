// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.3.1 — the deposit flow: exact human-amount → minor-unit conversion
// (excess precision REJECTS, never rounds), the intent → preflight → quote
// sequence, the full-disclosure preview derived from the exact typed data,
// and the sign → WS-L preflight/submit → attach pipeline.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWallets = vi.fn();
const mockManifest = vi.fn();
vi.mock('../../lib/queries.js', () => ({
  useWalletsQuery: () => mockWallets(),
  useKnomosisManifestQuery: () => mockManifest(),
}));

const mockCreateIntent = vi.fn();
const mockAdvance = vi.fn();
vi.mock('../../lib/treasury-api.js', () => ({
  createPaymentIntent: (...args: unknown[]) => mockCreateIntent(...args),
  advancePaymentIntent: (...args: unknown[]) => mockAdvance(...args),
}));

const mockPreflightAction = vi.fn();
const mockSubmitAction = vi.fn();
vi.mock('../../lib/wallet-api.js', () => ({
  preflightKnomosisAction: (...args: unknown[]) => mockPreflightAction(...args),
  submitKnomosisAction: (...args: unknown[]) => mockSubmitAction(...args),
}));

const mockSign = vi.fn();
vi.mock('../../lib/wallet-signing.js', () => ({
  discoverProviders: () => Promise.resolve([{ info: { rdns: 'io.test' }, provider: {} }]),
  requestAccount: () => Promise.resolve(`0x${'cd'.repeat(20)}`),
  freshNonce: () => '42',
  signatureExpiration: () => '9999999999',
  signTypedData: (...args: unknown[]) => mockSign(...args),
}));

import { DepositFlow } from './DepositFlow.js';

const TREASURY = {
  treasury_id: '11111111-1111-4111-8111-111111111111',
  room_id: '22222222-2222-4222-8222-222222222222',
  deployment_id: '33333333-3333-4333-8333-333333333333',
  treasury_address: `0x${'ab'.repeat(20)}`,
  accepted_assets: ['USDC'],
  balances: [],
  balances_reconciled_at: null,
  deposit_limits: {
    per_user_per_period: '100000000',
    per_room_per_period: '1000000000',
    per_deposit_max: '50000000',
    period_seconds: 86_400,
  },
  freeze_state: 'active' as const,
  freeze_reason: null,
  pause_flags: { deposits: false, proposals: false, executions: false },
  reconciliation_state: 'synced' as const,
  reserved_by_category: {},
  created_at: '2026-06-01T00:00:00.000Z',
};

const WALLET = {
  wallet_account_id: '44444444-4444-4444-8444-444444444444',
  label: 'Wallet 1',
  address_truncated: '0xcdcd…cdcd',
  chain_id: 1337,
  wallet_type: 'eoa',
  unlink_state: 'active',
  risk_state: 'normal',
  linked_at: '2026-06-01T00:00:00.000Z',
  last_used_at: null,
};

const MANIFEST = {
  deployment_id: TREASURY.deployment_id,
  chain_id: 1337,
  chain_name: 'Local Anvil',
  eip712_domain_version: '1',
  verifying_contract_address: `0x${'ef'.repeat(20)}`,
};

function setup(): void {
  mockWallets.mockReturnValue({ data: { items: [WALLET], nextCursor: null } });
  mockManifest.mockReturnValue({ data: MANIFEST });
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

function enterAmount(value: string): void {
  fireEvent.change(screen.getByLabelText(/amount/i), { target: { value } });
}

describe('DepositFlow (WS-M.3.1)', () => {
  it('rejects excess precision instead of rounding', async () => {
    render(<DepositFlow roomId="r1" treasury={TREASURY} onIntentCreated={() => {}} />);
    enterAmount('1.1234567'); // 7 decimals for a 6-decimal asset
    fireEvent.click(screen.getByRole('button', { name: /review deposit/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/valid amount/i)).toBeInTheDocument();
    expect(mockCreateIntent).not.toHaveBeenCalled();
  });

  it('walks intent → preflight → quote and shows the full-disclosure preview', async () => {
    mockCreateIntent.mockResolvedValue({
      payment_intent_id: '55555555-5555-4555-8555-555555555555',
      existing: false,
    });
    mockAdvance.mockResolvedValueOnce({ execution_state: 'preflighted' }).mockResolvedValueOnce({
      execution_state: 'quoted',
      quote: { estimated_fee: '1000', quoted_at: '2026-07-01T00:00:00.000Z' },
    });
    render(
      <DepositFlow roomId={TREASURY.room_id} treasury={TREASURY} onIntentCreated={() => {}} />,
    );
    enterAmount('1.5');
    fireEvent.click(screen.getByRole('button', { name: /review deposit/i }));

    await waitFor(() =>
      expect(screen.getByRole('region', { name: /review before signing/i })).toBeInTheDocument(),
    );
    // The EXACT minor-unit amount reached the intent (string math, no floats).
    expect(mockCreateIntent).toHaveBeenCalledWith(
      TREASURY.room_id,
      expect.objectContaining({
        target_type: 'treasury_deposit',
        target_id: TREASURY.treasury_id,
        asset: 'USDC',
        amount: '1500000',
      }),
    );
    expect(mockAdvance).toHaveBeenNthCalledWith(
      1,
      TREASURY.room_id,
      '55555555-5555-4555-8555-555555555555',
      'preflight',
    );
    // The preview shows the exact-outcome button + the quoted fee.
    expect(
      screen.getByRole('button', { name: /contribute 1\.5 USDC to the treasury/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/0\.001 USDC/)).toBeInTheDocument();
  });

  it('signs, runs the WS-L preflight/submit, and attaches the action record', async () => {
    const onIntentCreated = vi.fn();
    mockCreateIntent.mockResolvedValue({
      payment_intent_id: '55555555-5555-4555-8555-555555555555',
      existing: false,
    });
    mockAdvance.mockResolvedValue({ execution_state: 'ok' });
    mockSign.mockResolvedValue({
      signature: `0x${'11'.repeat(65)}`,
      message: { roomId: TREASURY.room_id },
    });
    mockPreflightAction.mockResolvedValue({
      result: 'pass',
      preflight_token: 'token-1234567890abcdef',
    });
    mockSubmitAction.mockResolvedValue({
      action_record_id: '66666666-6666-4666-8666-666666666666',
      submission_state: 'submitted',
      reason_code: null,
      human_message: null,
    });
    render(
      <DepositFlow
        roomId={TREASURY.room_id}
        treasury={TREASURY}
        onIntentCreated={onIntentCreated}
      />,
    );
    enterAmount('2');
    fireEvent.click(screen.getByRole('button', { name: /review deposit/i }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /review before signing/i })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /contribute 2 USDC to the treasury/i }));
    await waitFor(() =>
      expect(onIntentCreated).toHaveBeenCalledWith('55555555-5555-4555-8555-555555555555'),
    );
    expect(mockPreflightAction).toHaveBeenCalledWith(
      expect.objectContaining({ action_type: 'treasury_deposit' }),
    );
    expect(mockSubmitAction).toHaveBeenCalledWith(
      expect.objectContaining({ preflight_token: 'token-1234567890abcdef' }),
    );
    // The attach step bound the WS-L action record to the intent.
    expect(mockAdvance).toHaveBeenLastCalledWith(
      TREASURY.room_id,
      '55555555-5555-4555-8555-555555555555',
      'signed',
      '66666666-6666-4666-8666-666666666666',
    );
  });

  it('surfaces an intent-creation failure and never opens the preview', async () => {
    const { ApiClientError } = await import('../../lib/api.js');
    mockCreateIntent.mockRejectedValue(
      new ApiClientError('deposit_limit_exceeded', 'Over the per-deposit maximum.', 409),
    );
    render(<DepositFlow roomId="r1" treasury={TREASURY} onIntentCreated={() => {}} />);
    enterAmount('99');
    fireEvent.click(screen.getByRole('button', { name: /review deposit/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/per-deposit maximum/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: /review before signing/i }),
    ).not.toBeInTheDocument();
  });

  it('surfaces a wallet signing refusal at the preview stage', async () => {
    mockCreateIntent.mockResolvedValue({
      payment_intent_id: '55555555-5555-4555-8555-555555555555',
      existing: false,
    });
    mockAdvance.mockResolvedValue({ execution_state: 'ok' });
    mockSign.mockResolvedValue(null); // the wallet declined
    render(
      <DepositFlow roomId={TREASURY.room_id} treasury={TREASURY} onIntentCreated={() => {}} />,
    );
    enterAmount('1');
    fireEvent.click(screen.getByRole('button', { name: /review deposit/i }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /review before signing/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /contribute 1 USDC to the treasury/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/did not sign/i)).toBeInTheDocument();
    expect(mockPreflightAction).not.toHaveBeenCalled();
  });

  it('surfaces a WS-L preflight refusal with the server message', async () => {
    mockCreateIntent.mockResolvedValue({
      payment_intent_id: '55555555-5555-4555-8555-555555555555',
      existing: false,
    });
    mockAdvance.mockResolvedValue({ execution_state: 'ok' });
    mockSign.mockResolvedValue({
      signature: `0x${'11'.repeat(65)}`,
      message: { roomId: TREASURY.room_id },
    });
    mockPreflightAction.mockResolvedValue({
      result: 'fail',
      human_message: 'This region cannot move real funds.',
    });
    render(
      <DepositFlow roomId={TREASURY.room_id} treasury={TREASURY} onIntentCreated={() => {}} />,
    );
    enterAmount('1');
    fireEvent.click(screen.getByRole('button', { name: /review deposit/i }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /review before signing/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /contribute 1 USDC to the treasury/i }));
    await waitFor(() => expect(screen.getByText(/cannot move real funds/i)).toBeInTheDocument());
    expect(mockSubmitAction).not.toHaveBeenCalled();
  });

  it('asks for a linked wallet when none matches the deployment chain', async () => {
    mockWallets.mockReturnValue({ data: { items: [], nextCursor: null } });
    render(<DepositFlow roomId="r1" treasury={TREASURY} onIntentCreated={() => {}} />);
    enterAmount('1');
    fireEvent.click(screen.getByRole('button', { name: /review deposit/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/link a wallet/i)).toBeInTheDocument();
    expect(mockCreateIntent).not.toHaveBeenCalled();
  });

  it('blocks the flow when deposits are paused', () => {
    render(
      <DepositFlow
        roomId="r1"
        treasury={{
          ...TREASURY,
          pause_flags: { deposits: true, proposals: false, executions: false },
        }}
        onIntentCreated={() => {}}
      />,
    );
    enterAmount('1');
    expect(screen.getByRole('button', { name: /review deposit/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText(/paused by the room stewards/i)).toBeInTheDocument();
  });
});
