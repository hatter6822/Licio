// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.4d + WS-L.2.6a/c — the shared EIP-712 struct registry and the
// transaction-preview derivation.  The anti-blind-signing core: stable type
// hashes (snapshot), uniform anti-replay quartet, fail-closed lookup, preview
// fields structurally EQUAL to the signed message fields, exact-outcome button
// labels, and the no-custody sweep (no schema anywhere carries key material).

import { describe, expect, it } from 'vitest';
import {
  assembleTransactionPreview,
  buildTypedDataPayload,
  encodeStructType,
  formatMinorUnits,
  getTypedDataStruct,
  KNOMOSIS_SIGNED_ACTION_TYPES,
  KNOMOSIS_TYPED_DATA_REGISTRY,
  type KnomosisEip712Domain,
  PUBLIC_VISIBILITY_DISCLOSURE,
  primaryButtonLabel,
  truncateForDisplay,
} from '../knomosis/index.js';
import { knomosisSubmitRequestSchema } from '../schemas/knomosis-api.js';
import { walletLinkRequestSchema, walletSummarySchema } from '../schemas/wallet-api.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
const ADDR = '0x1111111111111111111111111111111111111111';
const DOMAIN: KnomosisEip712Domain = {
  name: 'Licio',
  version: '1',
  chainId: 31337,
  verifyingContract: '0x0000000000000000000000000000000000000002',
};

const binding = {
  actor: ADDR,
  nonce: '7',
  expiration: '1799999999',
  deploymentId: UUID2,
};

const MESSAGES: Record<string, Record<string, string>> = {
  proposal_sign: { roomId: UUID, proposalId: UUID2, ...binding },
  treasury_deposit: {
    roomId: UUID,
    treasuryId: UUID2,
    asset: 'USDC',
    amount: '10000000',
    ...binding,
  },
  grant_payout: {
    roomId: UUID,
    grantId: UUID2,
    recipient: ADDR,
    asset: 'USDC',
    amount: '5',
    ...binding,
  },
  charter_update: {
    roomId: UUID,
    charterVersionId: UUID2,
    contentHash: `0x${'ab'.repeat(32)}`,
    ...binding,
  },
  bounty_contribution: { roomId: UUID, bountyId: UUID2, asset: 'USDC', amount: '42', ...binding },
  steward_rotation: { roomId: UUID, incomingUserId: UUID2, outgoingUserId: UUID, ...binding },
};

describe('typed-data registry (WS-L.2.4d)', () => {
  it('has exactly one struct per signed action type', () => {
    expect(Object.keys(KNOMOSIS_TYPED_DATA_REGISTRY).sort()).toEqual(
      [...KNOMOSIS_SIGNED_ACTION_TYPES].sort(),
    );
  });

  it('every struct carries the uniform anti-replay quartet', () => {
    for (const actionType of KNOMOSIS_SIGNED_ACTION_TYPES) {
      const names = KNOMOSIS_TYPED_DATA_REGISTRY[actionType].fields.map((f) => f.name);
      for (const required of ['actor', 'nonce', 'expiration', 'deploymentId']) {
        expect(names, actionType).toContain(required);
      }
      // Every field has a plain-language label (the preview disclosure).
      for (const field of KNOMOSIS_TYPED_DATA_REGISTRY[actionType].fields) {
        expect(field.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('type-hash serializations are stable (NORMATIVE snapshot)', () => {
    const encoded = KNOMOSIS_SIGNED_ACTION_TYPES.map((t) =>
      encodeStructType(KNOMOSIS_TYPED_DATA_REGISTRY[t]),
    );
    expect(encoded).toEqual([
      'ProposalSignature(string roomId,string proposalId,address actor,uint256 nonce,uint256 expiration,string deploymentId)',
      'TreasuryDeposit(string roomId,string treasuryId,string asset,uint256 amount,address actor,uint256 nonce,uint256 expiration,string deploymentId)',
      'GrantPayout(string roomId,string grantId,address recipient,string asset,uint256 amount,address actor,uint256 nonce,uint256 expiration,string deploymentId)',
      'CharterUpdate(string roomId,string charterVersionId,bytes32 contentHash,address actor,uint256 nonce,uint256 expiration,string deploymentId)',
      'BountyContribution(string roomId,string bountyId,string asset,uint256 amount,address actor,uint256 nonce,uint256 expiration,string deploymentId)',
      'StewardRotation(string roomId,string incomingUserId,string outgoingUserId,address actor,uint256 nonce,uint256 expiration,string deploymentId)',
    ]);
  });

  it('fail-closed lookup: unknown action types have no struct', () => {
    expect(getTypedDataStruct('pay_to_rank')).toBeUndefined();
    expect(getTypedDataStruct('')).toBeUndefined();
    expect(getTypedDataStruct('proposal_sign')).toBeDefined();
  });

  it('builds a complete eth_signTypedData_v4 payload for every type', () => {
    for (const actionType of KNOMOSIS_SIGNED_ACTION_TYPES) {
      const message = MESSAGES[actionType];
      expect(message, actionType).toBeDefined();
      const payload = buildTypedDataPayload(actionType, DOMAIN, message ?? {});
      expect(payload.types['EIP712Domain']).toHaveLength(4);
      expect(payload.primaryType).toBe(KNOMOSIS_TYPED_DATA_REGISTRY[actionType].primaryType);
      expect(payload.message).toEqual(message);
    }
  });

  it('rejects messages failing the strict struct schema (fail-closed)', () => {
    expect(() =>
      buildTypedDataPayload('treasury_deposit', DOMAIN, {
        ...MESSAGES['treasury_deposit'],
        amount: '-5',
      }),
    ).toThrow();
    expect(() =>
      buildTypedDataPayload('treasury_deposit', DOMAIN, {
        ...MESSAGES['treasury_deposit'],
        extra_field: 'sneaky',
      }),
    ).toThrow();
    const { nonce, ...missingNonce } = MESSAGES['treasury_deposit'] ?? {};
    void nonce;
    expect(() => buildTypedDataPayload('treasury_deposit', DOMAIN, missingNonce)).toThrow();
  });
});

describe('formatMinorUnits (exact string math)', () => {
  it('formats without floats or precision loss', () => {
    expect(formatMinorUnits('1050000', 6)).toBe('1.05');
    expect(formatMinorUnits('1000000000000000000', 18)).toBe('1');
    expect(formatMinorUnits('1', 18)).toBe('0.000000000000000001');
    expect(formatMinorUnits('0', 6)).toBe('0');
    expect(formatMinorUnits('123', 0)).toBe('123');
  });

  it('rejects malformed inputs', () => {
    expect(() => formatMinorUnits('1.5', 6)).toThrow();
    expect(() => formatMinorUnits('-1', 6)).toThrow();
    expect(() => formatMinorUnits('1', -1)).toThrow();
  });
});

describe('transaction preview derivation (WS-L.2.6a/b/c)', () => {
  const context = {
    roomName: 'Test Room',
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

  it('preview fields are READ FROM the signed message (structural equality)', () => {
    const message = MESSAGES['treasury_deposit'] ?? {};
    const preview = assembleTransactionPreview('treasury_deposit', DOMAIN, message, context);
    expect(preview.nonce).toBe(message['nonce']);
    expect(preview.expiration).toBe(message['expiration']);
    expect(preview.amount).toBe(message['amount']);
    expect(preview.room_id).toBe(message['roomId']);
    expect(preview.wallet_address_truncated).toBe(truncateForDisplay(message['actor'] ?? ''));
    expect(preview.chain_id).toBe(DOMAIN.chainId);
    // EVERY signed field appears in the field-by-field disclosure.
    const disclosed = new Map(preview.signed_fields.map((f) => [f.name, f.value]));
    for (const [name, value] of Object.entries(message)) {
      expect(disclosed.get(name), name).toBe(value);
    }
  });

  it('always carries the §19.5 public-visibility disclosure', () => {
    const preview = assembleTransactionPreview(
      'proposal_sign',
      DOMAIN,
      MESSAGES['proposal_sign'] ?? {},
      context,
    );
    expect(preview.public_visibility_disclosure).toBe(PUBLIC_VISIBILITY_DISCLOSURE);
    expect(PUBLIC_VISIBILITY_DISCLOSURE).toContain('cannot be erased');
  });

  it('grant payouts surface the RECIPIENT, not the contract', () => {
    const message = MESSAGES['grant_payout'] ?? {};
    const preview = assembleTransactionPreview('grant_payout', DOMAIN, message, context);
    expect(preview.recipient_or_contract).toBe(truncateForDisplay(message['recipient'] ?? ''));
  });

  it('primary button labels state the exact outcome (never vague verbs)', () => {
    expect(primaryButtonLabel('treasury_deposit', '10', 'USDC')).toBe(
      'Contribute 10 USDC to the treasury',
    );
    expect(primaryButtonLabel('grant_payout', '5', 'USDC')).toBe('Execute grant payout of 5 USDC');
    expect(primaryButtonLabel('proposal_sign', null, null)).toBe('Sign proposal');
    for (const actionType of KNOMOSIS_SIGNED_ACTION_TYPES) {
      const label = primaryButtonLabel(actionType, '1', 'USDC');
      expect(label.toLowerCase()).not.toMatch(/^(confirm|continue|ok|submit)$/);
    }
  });

  it('rejects a message that fails the struct schema (no preview for garbage)', () => {
    expect(() =>
      assembleTransactionPreview('treasury_deposit', DOMAIN, { junk: 'x' }, context),
    ).toThrow();
  });
});

describe('no-custody sweep (WS-L DoD #13)', () => {
  it('no wallet/knomosis wire schema carries key or seed material', () => {
    const shapes = [walletLinkRequestSchema, walletSummarySchema, knomosisSubmitRequestSchema];
    for (const schema of shapes) {
      const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
      expect(shape).toBeDefined();
      if (shape) {
        expect(
          Object.keys(shape).some((k) => /seed|private[_-]?key|mnemonic|passphrase/i.test(k)),
        ).toBe(false);
      }
    }
  });
});
