// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.4d — the canonical EIP-712 typed-data struct registry for every
// wallet-signed Licio action (SPEC §17.3.1, §17.8, §25.6).  This is the SINGLE
// shared definition: the client builds the `eth_signTypedData_v4` payload and
// renders the transaction preview from it, and the server validates against it
// — there is no divergent second definition, so a user can never sign one thing
// while the server validates another.
//
// Every struct carries the uniform anti-replay/domain-binding quartet the
// planning doc requires: `nonce` (per-(user, deployment), WS-L.3.2c),
// `expiration` (unix seconds), `deploymentId` (cross-deployment binding), and
// `actor` (the signing wallet).  Cross-chain replay is defeated by the EIP-712
// domain `chainId` + `verifyingContract` (WS-L.2.4c); same-chain replay by the
// nonce.  This module is PURE DATA + string math (no crypto): digests and
// signature verification happen server-side via viem (apps/api), and the wallet
// itself hashes the client payload — `@licio/shared` never needs keccak.
//
// Fail-closed: an action type absent from this registry has no struct, so
// preflight/submission reject it (`ACTION_TYPE_UNKNOWN`).

import { z } from 'zod';

/** Registry version, pinned alongside the deployment (WS-L.2.4d). */
export const KNOMOSIS_TYPED_DATA_REGISTRY_VERSION = '2' as const;

/** EIP-712 domain `name` for every Licio signed action. */
export const KNOMOSIS_EIP712_DOMAIN_NAME = 'Licio' as const;

/** The six wallet-signed action types (WS-L.2.4d; SPEC §17.3.2/§17.3.3). */
export const KNOMOSIS_SIGNED_ACTION_TYPES = [
  'proposal_sign',
  'treasury_deposit',
  'grant_payout',
  'charter_update',
  'bounty_contribution',
  'steward_rotation',
] as const;
export type KnomosisSignedActionType = (typeof KNOMOSIS_SIGNED_ACTION_TYPES)[number];
export const knomosisSignedActionTypeSchema = z.enum(KNOMOSIS_SIGNED_ACTION_TYPES);

/** One EIP-712 struct field: solidity type + name + plain-language label. */
export interface TypedDataField {
  readonly name: string;
  readonly type: 'string' | 'address' | 'uint256' | 'bytes32';
  /** Plain-language label the transaction preview shows (WS-L.2.6a). */
  readonly label: string;
}

/** A 0x-prefixed 20-byte hex address (case-insensitive; checksum is verified server-side). */
export const hexAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { message: 'must be a 0x-prefixed 20-byte hex address' });

/** A 0x-prefixed 32-byte hex value. */
export const hexBytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { message: 'must be a 0x-prefixed 32-byte hex value' });

/** uint256 as a non-negative decimal integer string (fits any minor-unit amount). */
const UINT256_MAX = (1n << 256n) - 1n;
export const uint256StringSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/, { message: 'must be a canonical uint256 decimal string' })
  // 78 digits can EXCEED 2^256-1 (max uint256 is itself 78 digits), which a
  // digit-count regex cannot reject — enforce the exact ceiling with BigInt.
  .refine((s) => BigInt(s) <= UINT256_MAX, { message: 'exceeds the uint256 ceiling (2^256-1)' });

const uuidStringSchema = z.string().uuid();
const assetCodeSchema = z
  .string()
  .regex(/^[A-Z0-9-]{1,32}$/, { message: 'must be an upper-case asset code' });

// ---------------------------------------------------------------------------
// The anti-replay/domain-binding quartet shared by every struct (WS-L.2.4d).
// ---------------------------------------------------------------------------

const bindingFields: readonly TypedDataField[] = [
  { name: 'actor', type: 'address', label: 'Signing wallet' },
  { name: 'nonce', type: 'uint256', label: 'Anti-replay nonce' },
  { name: 'expiration', type: 'uint256', label: 'Signature expires (unix seconds)' },
  { name: 'deploymentId', type: 'string', label: 'Knomosis deployment' },
] as const;

const bindingShape = {
  actor: hexAddressSchema,
  nonce: uint256StringSchema,
  expiration: uint256StringSchema,
  deploymentId: uuidStringSchema,
} as const;

// ---------------------------------------------------------------------------
// Per-action structs.  Field ORDER is normative (it is hashed into the EIP-712
// type hash); changing it is a registry-version bump reviewed with the pin.
// ---------------------------------------------------------------------------

export const proposalSignatureMessageSchema = z
  .object({
    roomId: uuidStringSchema,
    proposalId: uuidStringSchema,
    /** What the signature authorizes (registry v2): the ballot purpose and
     *  the vote choice ride INSIDE the signed struct, so a wallet-approved
     *  payload can never be replayed as a different vote ('none' for
     *  non-vote purposes — EIP-712 strings cannot be null). */
    purpose: z.enum(['vote', 'approval', 'multisig']),
    choice: z.enum(['approve', 'reject', 'abstain', 'none']),
    ...bindingShape,
  })
  .strict();
export type ProposalSignatureMessage = z.infer<typeof proposalSignatureMessageSchema>;

export const treasuryDepositMessageSchema = z
  .object({
    roomId: uuidStringSchema,
    treasuryId: uuidStringSchema,
    asset: assetCodeSchema,
    amount: uint256StringSchema,
    ...bindingShape,
  })
  .strict();
export type TreasuryDepositMessage = z.infer<typeof treasuryDepositMessageSchema>;

export const grantPayoutMessageSchema = z
  .object({
    roomId: uuidStringSchema,
    grantId: uuidStringSchema,
    recipient: hexAddressSchema,
    asset: assetCodeSchema,
    amount: uint256StringSchema,
    ...bindingShape,
  })
  .strict();
export type GrantPayoutMessage = z.infer<typeof grantPayoutMessageSchema>;

export const charterUpdateMessageSchema = z
  .object({
    roomId: uuidStringSchema,
    charterVersionId: uuidStringSchema,
    /** keccak/sha-256 commitment to the charter text (off-chain record, §19.5). */
    contentHash: hexBytes32Schema,
    ...bindingShape,
  })
  .strict();
export type CharterUpdateMessage = z.infer<typeof charterUpdateMessageSchema>;

export const bountyContributionMessageSchema = z
  .object({
    roomId: uuidStringSchema,
    bountyId: uuidStringSchema,
    asset: assetCodeSchema,
    amount: uint256StringSchema,
    ...bindingShape,
  })
  .strict();
export type BountyContributionMessage = z.infer<typeof bountyContributionMessageSchema>;

export const stewardRotationMessageSchema = z
  .object({
    roomId: uuidStringSchema,
    incomingUserId: uuidStringSchema,
    outgoingUserId: uuidStringSchema,
    ...bindingShape,
  })
  .strict();
export type StewardRotationMessage = z.infer<typeof stewardRotationMessageSchema>;

export type KnomosisTypedDataMessage =
  | ProposalSignatureMessage
  | TreasuryDepositMessage
  | GrantPayoutMessage
  | CharterUpdateMessage
  | BountyContributionMessage
  | StewardRotationMessage;

/** One registry entry: primary type, ordered fields, message validator, naming. */
export interface KnomosisTypedDataStruct {
  readonly actionType: KnomosisSignedActionType;
  readonly primaryType: string;
  readonly fields: readonly TypedDataField[];
  /** Strict zod validator for the message object of this struct. */
  readonly messageSchema: z.ZodType<Record<string, string>>;
  /** Plain-language action name template (WS-L.2.6a; never a function signature). */
  readonly actionName: string;
}

const structFields = (own: readonly TypedDataField[]): readonly TypedDataField[] => [
  ...own,
  ...bindingFields,
];

/**
 * THE registry (WS-L.2.4d).  Exactly one struct per signed action type; adding a
 * new action type means adding a struct here (fail-closed everywhere else).
 */
export const KNOMOSIS_TYPED_DATA_REGISTRY: Readonly<
  Record<KnomosisSignedActionType, KnomosisTypedDataStruct>
> = {
  proposal_sign: {
    actionType: 'proposal_sign',
    primaryType: 'ProposalSignature',
    fields: structFields([
      { name: 'roomId', type: 'string', label: 'Room' },
      { name: 'proposalId', type: 'string', label: 'Proposal' },
      { name: 'purpose', type: 'string', label: 'Signature purpose' },
      { name: 'choice', type: 'string', label: 'Vote choice' },
    ]),
    messageSchema: proposalSignatureMessageSchema,
    actionName: 'Sign governance proposal',
  },
  treasury_deposit: {
    actionType: 'treasury_deposit',
    primaryType: 'TreasuryDeposit',
    fields: structFields([
      { name: 'roomId', type: 'string', label: 'Room' },
      { name: 'treasuryId', type: 'string', label: 'Room treasury' },
      { name: 'asset', type: 'string', label: 'Asset' },
      { name: 'amount', type: 'uint256', label: 'Amount (minor units)' },
    ]),
    messageSchema: treasuryDepositMessageSchema,
    actionName: 'Contribute to the room treasury',
  },
  grant_payout: {
    actionType: 'grant_payout',
    primaryType: 'GrantPayout',
    fields: structFields([
      { name: 'roomId', type: 'string', label: 'Room' },
      { name: 'grantId', type: 'string', label: 'Grant' },
      { name: 'recipient', type: 'address', label: 'Recipient wallet' },
      { name: 'asset', type: 'string', label: 'Asset' },
      { name: 'amount', type: 'uint256', label: 'Amount (minor units)' },
    ]),
    messageSchema: grantPayoutMessageSchema,
    actionName: 'Execute grant payout',
  },
  charter_update: {
    actionType: 'charter_update',
    primaryType: 'CharterUpdate',
    fields: structFields([
      { name: 'roomId', type: 'string', label: 'Room' },
      { name: 'charterVersionId', type: 'string', label: 'Charter version' },
      { name: 'contentHash', type: 'bytes32', label: 'Charter content commitment' },
    ]),
    messageSchema: charterUpdateMessageSchema,
    actionName: 'Approve charter update',
  },
  bounty_contribution: {
    actionType: 'bounty_contribution',
    primaryType: 'BountyContribution',
    fields: structFields([
      { name: 'roomId', type: 'string', label: 'Room' },
      { name: 'bountyId', type: 'string', label: 'Evidence bounty' },
      { name: 'asset', type: 'string', label: 'Asset' },
      { name: 'amount', type: 'uint256', label: 'Amount (minor units)' },
    ]),
    messageSchema: bountyContributionMessageSchema,
    actionName: 'Contribute to evidence bounty',
  },
  steward_rotation: {
    actionType: 'steward_rotation',
    primaryType: 'StewardRotation',
    fields: structFields([
      { name: 'roomId', type: 'string', label: 'Room' },
      { name: 'incomingUserId', type: 'string', label: 'Incoming steward' },
      { name: 'outgoingUserId', type: 'string', label: 'Outgoing steward' },
    ]),
    messageSchema: stewardRotationMessageSchema,
    actionName: 'Approve steward rotation',
  },
};

/** Fail-closed lookup: `undefined` for anything not in the registry. */
export function getTypedDataStruct(actionType: string): KnomosisTypedDataStruct | undefined {
  return knomosisSignedActionTypeSchema.safeParse(actionType).success
    ? KNOMOSIS_TYPED_DATA_REGISTRY[actionType as KnomosisSignedActionType]
    : undefined;
}

// ---------------------------------------------------------------------------
// EIP-712 assembly (pure — the wallet and the server do the hashing).
// ---------------------------------------------------------------------------

/** The EIP-712 domain for a pinned deployment (WS-L.2.4c). */
export interface KnomosisEip712Domain {
  readonly name: typeof KNOMOSIS_EIP712_DOMAIN_NAME;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: string;
}

export const knomosisEip712DomainSchema = z
  .object({
    name: z.literal(KNOMOSIS_EIP712_DOMAIN_NAME),
    version: z.string().min(1).max(16),
    chainId: z.number().int().positive(),
    verifyingContract: hexAddressSchema,
  })
  .strict();

/** The exact JSON payload for `eth_signTypedData_v4` (client) / viem (server). */
export interface KnomosisTypedDataPayload {
  readonly domain: KnomosisEip712Domain;
  readonly primaryType: string;
  readonly types: Record<string, Array<{ name: string; type: string }>>;
  readonly message: Record<string, string>;
}

/**
 * Build the full typed-data payload for an action.  Throws on an unregistered
 * action type or a message that fails the struct's strict schema (fail-closed).
 */
export function buildTypedDataPayload(
  actionType: KnomosisSignedActionType,
  domain: KnomosisEip712Domain,
  message: Record<string, string>,
): KnomosisTypedDataPayload {
  const struct = KNOMOSIS_TYPED_DATA_REGISTRY[actionType];
  const parsedDomain = knomosisEip712DomainSchema.parse(domain);
  const parsedMessage = struct.messageSchema.parse(message);
  return {
    domain: parsedDomain,
    primaryType: struct.primaryType,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [struct.primaryType]: struct.fields.map(({ name, type }) => ({ name, type })),
    },
    message: parsedMessage,
  };
}

/**
 * The EIP-712 `encodeType` string for a struct (e.g.
 * `ProposalSignature(string roomId,…,uint256 nonce,…)`) — the normative,
 * snapshot-tested serialization whose keccak is the struct's type hash.  Our
 * structs are flat (no nested struct types), so no referenced-type suffix is
 * ever appended.
 */
export function encodeStructType(struct: KnomosisTypedDataStruct): string {
  const fields = struct.fields.map((f) => `${f.type} ${f.name}`).join(',');
  return `${struct.primaryType}(${fields})`;
}
