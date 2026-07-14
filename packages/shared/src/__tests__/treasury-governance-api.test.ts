// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  modeTransitionRequestSchema,
  READINESS_REQUIREMENTS,
  roomReadinessResponseSchema,
} from '../schemas/knomosis-api.js';
import {
  accountingExportResponseSchema,
  charterCreateRequestSchema,
  charterSectionsSchema,
  delegationCreateRequestSchema,
  depositLimitsSchema,
  grantCreateRequestSchema,
  PAYMENT_INTENT_STATES,
  paymentIntentCreateRequestSchema,
  paymentIntentSchema,
  productionProposalCreateSchema,
  proposalChallengeRequestSchema,
  proposalSignRequestSchema,
  readinessAttestationRequestSchema,
  roomGovernanceProfileSchema,
  roomTreasurySchema,
  treasuryCreateRequestSchema,
  treasuryFreezeRequestSchema,
  treasuryPauseRequestSchema,
  treasuryReconciliationSnapshotSchema,
} from '../schemas/treasury-governance-api.js';

const UUID = '4c2f8a94-1a5b-4c1e-9f7d-2b6a8c0e1d23';
const NOW = '2026-07-13T00:00:00.000Z';

describe('WS-M canonical vocabularies', () => {
  it('carries exactly the thirteen §22.2 payment-intent states', () => {
    expect(PAYMENT_INTENT_STATES).toHaveLength(13);
    expect(PAYMENT_INTENT_STATES).toContain('reorged');
    expect(PAYMENT_INTENT_STATES).toContain('disputed');
  });

  it('extends the readiness vocabulary with the four WS-M.1.2e items', () => {
    for (const item of [
      'jurisdiction_supported',
      'law_pack_valid',
      'governance_model_ratified',
      'external_audit_passed',
    ]) {
      expect(READINESS_REQUIREMENTS).toContain(item);
    }
  });
});

describe('roomReadinessResponseSchema (extended, wire-compatible)', () => {
  it('still accepts the legacy WS-L.4.1g shape', () => {
    const legacy = {
      room_id: UUID,
      current_mode: 'simulated',
      ready: false,
      unmet: [{ requirement: 'charter_present', description: 'The room needs a charter.' }],
    };
    expect(roomReadinessResponseSchema.parse(legacy)).toEqual(legacy);
  });

  it('accepts the WS-M per-item extension', () => {
    const extended = {
      room_id: UUID,
      current_mode: 'simulated',
      target_mode: 'testnet' as const,
      ready: false,
      unmet: [],
      items: [
        {
          requirement: 'external_audit_passed' as const,
          status: 'not_applicable' as const,
          description: 'External audit applies to mature production only.',
          required_for: ['mature_production' as const],
          evaluated_at: NOW,
        },
      ],
    };
    expect(roomReadinessResponseSchema.parse(extended).items).toHaveLength(1);
  });
});

describe('modeTransitionRequestSchema (extended targets)', () => {
  it('accepts every WS-M.1.1b target mode', () => {
    for (const target of [
      'ordinary',
      'simulated',
      'testnet',
      'capped_production',
      'mature_production',
      'frozen',
      'migrating',
    ]) {
      expect(
        modeTransitionRequestSchema.parse({ target_mode: target, reason: 'audited transition' })
          .target_mode,
      ).toBe(target);
    }
  });

  it('rejects unknown targets', () => {
    expect(
      modeTransitionRequestSchema.safeParse({ target_mode: 'super_mode', reason: 'x' }).success,
    ).toBe(false);
  });
});

describe('charter schemas (WS-M.1.2a)', () => {
  const section = 'A plain-language description of this room, long enough to be real.';
  const sections = {
    purpose: section,
    decision_making: section,
    fund_management: section,
    member_rights: section,
    dispute_resolution: section,
    amendment_process: section,
    safety_override_acknowledgment: section,
    appeals_path: section,
  };

  it('requires every section (missing sections reject)', () => {
    expect(charterSectionsSchema.safeParse(sections).success).toBe(true);
    const { appeals_path, ...missing } = sections;
    void appeals_path;
    expect(charterSectionsSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects trivially short section text', () => {
    expect(
      charterCreateRequestSchema.safeParse({ sections: { ...sections, purpose: 'tiny' } }).success,
    ).toBe(false);
  });
});

describe('treasury schemas (WS-M.2.1a/2.2a)', () => {
  const limits = {
    per_user_per_period: '1000000',
    per_room_per_period: '10000000',
    per_deposit_max: '500000',
    period_seconds: 86_400,
  };

  it('accepts a valid create request with a lowercase address', () => {
    const request = {
      deployment_id: UUID,
      treasury_address: `0x${'ab'.repeat(20)}`,
      accepted_assets: ['USDC'],
      deposit_limits: limits,
    };
    expect(treasuryCreateRequestSchema.parse(request).treasury_address).toBe(
      `0x${'ab'.repeat(20)}`,
    );
  });

  it('rejects checksummed (non-lowercase) addresses', () => {
    expect(
      treasuryCreateRequestSchema.safeParse({
        deployment_id: UUID,
        treasury_address: `0x${'AB'.repeat(20)}`,
        accepted_assets: ['USDC'],
        deposit_limits: limits,
      }).success,
    ).toBe(false);
  });

  it('rejects zero deposit limits (positive minor units required)', () => {
    expect(depositLimitsSchema.safeParse({ ...limits, per_deposit_max: '0' }).success).toBe(false);
  });

  it('round-trips the treasury dashboard row', () => {
    const treasury = {
      treasury_id: UUID,
      room_id: UUID,
      deployment_id: UUID,
      treasury_address: `0x${'cd'.repeat(20)}`,
      accepted_assets: ['USDC'],
      balances: [{ asset: 'USDC', amount: '123456' }],
      balances_reconciled_at: NOW,
      deposit_limits: limits,
      freeze_state: 'active' as const,
      freeze_reason: null,
      pause_flags: { deposits: false, proposals: false, executions: false },
      reconciliation_state: 'synced' as const,
      reserved_by_category: { grant: '1000' },
      created_at: NOW,
    };
    expect(roomTreasurySchema.parse(treasury)).toEqual(treasury);
  });
});

describe('payment-intent wire (WS-M.3.1a-c)', () => {
  it('requires the idempotency key on creation', () => {
    const missing = paymentIntentCreateRequestSchema.safeParse({
      target_type: 'treasury_deposit',
      target_id: UUID,
      asset: 'USDC',
      amount: '100',
    });
    expect(missing.success).toBe(false);
  });

  it('rejects zero and float amounts', () => {
    for (const amount of ['0', '1.5', '-3']) {
      expect(
        paymentIntentCreateRequestSchema.safeParse({
          target_type: 'treasury_deposit',
          target_id: UUID,
          asset: 'USDC',
          amount,
          idempotency_key: UUID,
        }).success,
      ).toBe(false);
    }
  });

  it('round-trips a full intent record with fail-closed defaults visible', () => {
    const intent = {
      payment_intent_id: UUID,
      user_id: UUID,
      room_id: UUID,
      target_type: 'grant_payout' as const,
      target_id: UUID,
      asset: 'USDC',
      amount: '250000',
      jurisdiction_state: 'blocked' as const,
      compliance_state: 'pending' as const,
      execution_state: 'created' as const,
      retry_count: 0,
      action_record_id: null,
      receipt_id: null,
      expires_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    };
    expect(paymentIntentSchema.parse(intent)).toEqual(intent);
  });
});

describe('production proposal wire (WS-M.4.1a/b)', () => {
  const create = {
    proposal_type: 'capped_grant',
    title: 'Fund the translation sprint',
    plain_language_summary: 'Pay a contributor to translate the room charter.',
    category: 'grant',
    requested_amount: '100000',
    asset: 'USDC',
    recipient_ref: 'user:abc',
    conflict_disclosures: 'None: no relationship with the recipient.',
    risk_assessment: 'Low: capped, milestone-gated.',
    requested_action: { kind: 'grant' },
    expected_deliverable: 'A published translation.',
    idempotency_key: UUID,
  };

  it('accepts a complete spend draft', () => {
    expect(productionProposalCreateSchema.parse(create).category).toBe('grant');
  });

  it('enforces the 200-char title cap', () => {
    expect(
      productionProposalCreateSchema.safeParse({ ...create, title: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('sign requests carry typed data + a real signature shape', () => {
    const sign = {
      purpose: 'vote' as const,
      choice: 'approve' as const,
      deployment_id: UUID,
      wallet_account_id: UUID,
      typed_data_message: { roomId: UUID, nonce: '1' },
      signature: `0x${'a'.repeat(130)}`,
    };
    expect(proposalSignRequestSchema.parse(sign).purpose).toBe('vote');
    expect(proposalSignRequestSchema.safeParse({ ...sign, signature: 'not-hex' }).success).toBe(
      false,
    );
  });

  it('challenges require a substantive description', () => {
    expect(
      proposalChallengeRequestSchema.safeParse({
        challenge_type: 'coi',
        description: 'too short',
        evidence_refs: [],
      }).success,
    ).toBe(false);
  });
});

describe('grants + delegation + freeze wire', () => {
  it('grant creation requires at least one milestone', () => {
    expect(
      grantCreateRequestSchema.safeParse({
        proposal_id: UUID,
        recipient_ref: 'user:abc',
        purpose: 'Translation work',
        milestones: [],
      }).success,
    ).toBe(false);
  });

  it('delegation scope is either all or one proposal type', () => {
    expect(
      delegationCreateRequestSchema.parse({ delegate_user_id: UUID, scope: { all: true } }).scope,
    ).toEqual({ all: true });
    expect(
      delegationCreateRequestSchema.parse({
        delegate_user_id: UUID,
        scope: { proposal_type: 'capped_grant' },
      }).scope,
    ).toEqual({ proposal_type: 'capped_grant' });
    expect(
      delegationCreateRequestSchema.safeParse({ delegate_user_id: UUID, scope: {} }).success,
    ).toBe(false);
  });

  it('freeze requests carry scope + source + reason', () => {
    const freeze = {
      action: 'freeze' as const,
      scope: 'treasury' as const,
      source: 'platform_security' as const,
      reason: 'Reconciliation divergence under review.',
    };
    expect(treasuryFreezeRequestSchema.parse(freeze)).toEqual(freeze);
  });

  it('pause requests are partial (only named scopes change)', () => {
    const pause = treasuryPauseRequestSchema.parse({ deposits: true, reason: 'maintenance' });
    expect(pause.deposits).toBe(true);
    expect(pause.proposals).toBeUndefined();
  });

  it('attestations are limited to the two attestable items', () => {
    expect(
      readinessAttestationRequestSchema.safeParse({ item: 'charter_present', note: 'x'.repeat(20) })
        .success,
    ).toBe(false);
    expect(
      readinessAttestationRequestSchema.parse({
        item: 'safety_override_acknowledged',
        note: 'The stewards acknowledge platform-moderation supremacy.',
      }).item,
    ).toBe('safety_override_acknowledged');
  });
});

describe('reconciliation + export wire (WS-M.5.2a/b)', () => {
  it('an explained snapshot requires a non-null explanation payload', () => {
    const base = {
      snapshot_id: UUID,
      treasury_id: UUID,
      asset: 'USDC',
      product_ledger_balance: '1000',
      receipts_balance: '900',
      onchain_observed_balance: '900',
      gap: '100',
      result: 'explained' as const,
      observed_at: NOW,
    };
    // The wire allows null structurally; the SERVICE enforces non-null on
    // `explained` (tested there) — here we assert the shape round-trips.
    expect(
      treasuryReconciliationSnapshotSchema.parse({
        ...base,
        explanation: { pending_intent: UUID },
      }).result,
    ).toBe('explained');
  });

  it('accounting export rows use event-time USD and flag exclusions', () => {
    const parsed = accountingExportResponseSchema.parse({
      treasury_id: UUID,
      period_start: NOW,
      period_end: NOW,
      export_schema_version: 1,
      rows: [
        {
          event_kind: 'deposit',
          receipt_id: UUID,
          tx_hash: `0x${'1'.repeat(64)}`,
          asset: 'USDC',
          amount: '5000',
          usd_equivalent_at_event: '5.00',
          category: null,
          reconciliation_result: 'synced',
          occurred_at: NOW,
        },
      ],
      excluded_unreconciled: 2,
    });
    expect(parsed.excluded_unreconciled).toBe(2);
  });
});

describe('governance profile wire (WS-M.1.1a)', () => {
  it('round-trips with fail-closed pause flags', () => {
    const profile = {
      room_id: UUID,
      governance_mode: 'testnet',
      law_pack_id: UUID,
      charter_version_id: UUID,
      treasury_id: null,
      freeze_state: 'frozen' as const,
      freeze_reason: 'Under review.',
      pause_flags: { deposits: true, proposals: true, executions: true },
      updated_at: NOW,
    };
    expect(roomGovernanceProfileSchema.parse(profile)).toEqual(profile);
  });
});
