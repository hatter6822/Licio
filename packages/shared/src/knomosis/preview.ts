// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.6a/b/c — transaction-preview assembly (SPEC §17.8).  The preview is
// DERIVED from the registered typed-data struct and the exact message object
// that will be signed — never from a parallel object — so the displayed
// amount/recipient/nonce/expiration structurally CANNOT diverge from the signed
// payload (the anti-bait-and-switch property, tested by field equality).
//
// UX constraints (WS-L.2.6c) are encoded here as data: the primary button label
// states the exact outcome (never "Confirm"/"Continue"), and the preview object
// has no field a countdown timer, scarcity banner, or hidden fee could render
// from.  Reversibility wording comes from the validated finality memo via the
// pinned deployment (WS-L.1.1b-1), never guessed at the call site.

import { z } from 'zod';
import {
  KNOMOSIS_TYPED_DATA_REGISTRY,
  type KnomosisEip712Domain,
  type KnomosisSignedActionType,
  type TypedDataField,
} from './typed-data.js';

/** Risk labels shown on the preview (WS-L.2.6b; from wallet risk state + action). */
export const PREVIEW_RISK_LABELS = ['normal', 'elevated', 'high'] as const;
export type PreviewRiskLabel = (typeof PREVIEW_RISK_LABELS)[number];
export const previewRiskLabelSchema = z.enum(PREVIEW_RISK_LABELS);

/** The §19.5 disclosure shown on EVERY on-chain action preview (WS-L.2.6b). */
export const PUBLIC_VISIBILITY_DISCLOSURE =
  'This action will be recorded in the public audit log and on a public chain; on-chain records are durable and cannot be erased by Licio.';

/** Caller-supplied context the preview needs beyond the signed fields. */
export interface PreviewContext {
  readonly roomName: string;
  /** Estimated network fee as a display string (all fees upfront, WS-L.2.6c). */
  readonly estimatedFee: string;
  /** Reversibility statement from the WS-L.1.1b-1 memo for this action type. */
  readonly reversibilityStatement: string;
  /** Human-readable timelock/challenge period, when the action has one. */
  readonly timelock: string | null;
  readonly jurisdictionStatus: string;
  readonly riskLabel: PreviewRiskLabel;
  readonly chainName: string;
  /** Deep link to the related proposal/bounty, when applicable. */
  readonly relatedLink: string | null;
  readonly supportContact: string;
  /** Display form of the amount (derived via {@link formatMinorUnits}). */
  readonly displayAmount: string | null;
}

/** The assembled full-disclosure preview (the §17.8 field list). */
export interface TransactionPreview {
  readonly action_name: string;
  readonly room_name: string;
  readonly room_id: string;
  readonly recipient_or_contract: string;
  readonly asset: string | null;
  readonly amount: string | null;
  readonly estimated_fee: string;
  readonly reversibility_statement: string;
  readonly timelock: string | null;
  readonly public_visibility_disclosure: typeof PUBLIC_VISIBILITY_DISCLOSURE;
  readonly jurisdiction_status: string;
  readonly risk_label: PreviewRiskLabel;
  readonly wallet_address_truncated: string;
  readonly chain_id: number;
  readonly chain_name: string;
  readonly contract_domain: string;
  readonly expiration: string;
  readonly nonce: string;
  readonly related_link: string | null;
  readonly support_contact: string;
  /** Exact-outcome primary button label (WS-L.2.6c). */
  readonly primary_button_label: string;
  /** Field-by-field disclosure of EVERY signed field with its label. */
  readonly signed_fields: ReadonlyArray<{ label: string; name: string; value: string }>;
}

/** Truncate an address/id for display: first 6 + last 4 (WS-L.2.5c format). */
export function truncateForDisplay(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Format a minor-unit uint256 decimal string as a display amount with
 * `decimals` fractional digits, exactly (pure string math — no floats, no
 * precision loss; e.g. ("1050000", 6) → "1.05").
 */
export function formatMinorUnits(amount: string, decimals: number): string {
  if (!/^(0|[1-9]\d*)$/.test(amount)) throw new Error('amount must be a decimal integer string');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error('decimals out of range');
  }
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/** Exact-outcome primary button labels (WS-L.2.6c: never vague verbs). */
export function primaryButtonLabel(
  actionType: KnomosisSignedActionType,
  displayAmount: string | null,
  asset: string | null,
): string {
  const amount = displayAmount !== null && asset !== null ? `${displayAmount} ${asset}` : null;
  switch (actionType) {
    case 'proposal_sign':
      return 'Sign proposal';
    case 'treasury_deposit':
      return amount !== null
        ? `Contribute ${amount} to the treasury`
        : 'Contribute to the treasury';
    case 'grant_payout':
      return amount !== null ? `Execute grant payout of ${amount}` : 'Execute grant payout';
    case 'charter_update':
      return 'Sign charter update';
    case 'bounty_contribution':
      return amount !== null ? `Contribute ${amount} to the bounty` : 'Contribute to the bounty';
    case 'steward_rotation':
      return 'Approve steward rotation';
    default: {
      const exhaustive: never = actionType;
      throw new Error(`unhandled action type: ${String(exhaustive)}`);
    }
  }
}

const fieldValue = (message: Record<string, string>, name: string): string => {
  const value = message[name];
  if (value === undefined) throw new Error(`signed message is missing field "${name}"`);
  return value;
};

/**
 * Assemble the full-disclosure preview for a validated typed-data message
 * (WS-L.2.6a/b).  Amount, recipient, nonce, and expiration are read from the
 * MESSAGE OBJECT ITSELF; the struct's field labels drive the field-by-field
 * disclosure, so every signed field is shown and no display-only claim exists
 * that is not in the signed data.
 */
export function assembleTransactionPreview(
  actionType: KnomosisSignedActionType,
  domain: KnomosisEip712Domain,
  message: Record<string, string>,
  context: PreviewContext,
): TransactionPreview {
  const struct = KNOMOSIS_TYPED_DATA_REGISTRY[actionType];
  const parsed = struct.messageSchema.parse(message);

  const asset = parsed['asset'] ?? null;
  const amount = parsed['amount'] ?? null;
  const recipient = parsed['recipient'] ?? domain.verifyingContract;

  return {
    action_name: struct.actionName,
    room_name: context.roomName,
    room_id: fieldValue(parsed, 'roomId'),
    recipient_or_contract: truncateForDisplay(recipient),
    asset,
    amount,
    estimated_fee: context.estimatedFee,
    reversibility_statement: context.reversibilityStatement,
    timelock: context.timelock,
    public_visibility_disclosure: PUBLIC_VISIBILITY_DISCLOSURE,
    jurisdiction_status: context.jurisdictionStatus,
    risk_label: context.riskLabel,
    wallet_address_truncated: truncateForDisplay(fieldValue(parsed, 'actor')),
    chain_id: domain.chainId,
    chain_name: context.chainName,
    contract_domain: `${domain.name} v${domain.version} @ ${truncateForDisplay(domain.verifyingContract)}`,
    expiration: fieldValue(parsed, 'expiration'),
    nonce: fieldValue(parsed, 'nonce'),
    related_link: context.relatedLink,
    support_contact: context.supportContact,
    primary_button_label: primaryButtonLabel(actionType, context.displayAmount, asset),
    signed_fields: struct.fields.map((f: TypedDataField) => ({
      label: f.label,
      name: f.name,
      value: fieldValue(parsed, f.name),
    })),
  };
}
