// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.6a-d — the transaction preview is the anti-blind-signing surface:
// every signed field is disclosed, the durability disclosure is always shown,
// the primary button states the exact outcome, cancel is present, and the risk
// label is announced.  Accessible (axe).

import { assembleTransactionPreview, type KnomosisEip712Domain } from '@licio/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { TransactionPreviewCard } from './TransactionPreview.js';

const DOMAIN: KnomosisEip712Domain = {
  name: 'Licio',
  version: '1',
  chainId: 31337,
  verifyingContract: '0x0000000000000000000000000000000000000002',
};
const MESSAGE = {
  roomId: '11111111-1111-4111-8111-111111111111',
  treasuryId: '22222222-2222-4222-8222-222222222222',
  asset: 'USDC',
  amount: '10000000',
  actor: '0x1111111111111111111111111111111111111111',
  nonce: '7',
  expiration: '1799999999',
  deploymentId: '22222222-2222-4222-8222-222222222222',
};
const CONTEXT = {
  roomName: 'Water Quality',
  estimatedFee: '~0.0001 ETH',
  reversibilityStatement: 'Deposits are final once settled.',
  timelock: null,
  jurisdictionStatus: 'Available in your region',
  riskLabel: 'normal' as const,
  chainName: 'Licio local devnet',
  relatedLink: null,
  supportContact: 'support@licio.app',
  displayAmount: '10',
};

function preview(riskLabel: 'normal' | 'elevated' | 'high' = 'normal') {
  return assembleTransactionPreview('treasury_deposit', DOMAIN, MESSAGE, {
    ...CONTEXT,
    riskLabel,
  });
}

describe('TransactionPreviewCard', () => {
  it('discloses every signed field value and the durability warning', () => {
    render(<TransactionPreviewCard preview={preview()} onSign={vi.fn()} onCancel={vi.fn()} />);
    // The nonce and expiration exactly match the signed message (they appear in the
    // friendly summary AND the authoritative signed-fields disclosure).
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1799999999').length).toBeGreaterThan(0);
    // §19.5 durability disclosure is always present.
    expect(screen.getByText(/cannot be erased/i)).toBeInTheDocument();
    expect(screen.getByText(/final once settled/i)).toBeInTheDocument();
  });

  it('renders EVERY signed field — incl. proposal_sign.proposalId not in the summary (F2)', () => {
    const PROPOSAL_MESSAGE = {
      roomId: '11111111-1111-4111-8111-111111111111',
      proposalId: '99999999-9999-4999-8999-999999999999',
      purpose: 'vote',
      choice: 'approve',
      actor: '0x1111111111111111111111111111111111111111',
      nonce: '3',
      expiration: '1799999999',
      deploymentId: '22222222-2222-4222-8222-222222222222',
    };
    const proposalPreview = assembleTransactionPreview('proposal_sign', DOMAIN, PROPOSAL_MESSAGE, {
      ...CONTEXT,
      displayAmount: null,
    });
    render(
      <TransactionPreviewCard preview={proposalPreview} onSign={vi.fn()} onCancel={vi.fn()} />,
    );
    // The proposalId is ONLY in signed_fields (the summary shows the contract) —
    // the user must see the exact proposal they are signing before signing (F2).
    expect(screen.getByText('99999999-9999-4999-8999-999999999999')).toBeInTheDocument();
    expect(screen.getByText(/exactly what you will sign/i)).toBeInTheDocument();
  });

  it('primary button states the exact outcome (never a vague verb)', () => {
    render(<TransactionPreviewCard preview={preview()} onSign={vi.fn()} onCancel={vi.fn()} />);
    const primary = screen.getByRole('button', { name: /contribute 10 usdc to the treasury/i });
    expect(primary).toBeInTheDocument();
    // A cancel option is present and equally available.
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('signing is blocked while step-up is required (WS-L.2.6e)', () => {
    const onSign = vi.fn();
    render(
      <TransactionPreviewCard
        preview={preview('high')}
        signDisabled
        signDisabledReason="Additional verification required."
        onSign={onSign}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/additional verification required/i)).toBeInTheDocument();
    const primary = screen.getByRole('button', { name: /contribute 10 usdc to the treasury/i });
    fireEvent.click(primary);
    expect(onSign).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <TransactionPreviewCard preview={preview('elevated')} onSign={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
