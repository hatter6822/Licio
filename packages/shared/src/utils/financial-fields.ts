// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Financial-field denylist (WS-F.2.5b, SPEC §21.5/§13.6) — the SHARED term
// list and matcher behind the no-pay-to-rank structural guarantee. The WS-F
// content-schema assertion (packages/db) enforces it at the PRODUCER (no
// content table can carry a financial column) and the WS-I.2.1b feature-store
// check will enforce the same list at the CONSUMER, so the two can never
// drift.
//
// Matching is segment-based, not substring-based: `fee` must flag `entry_fee`
// but NOT `feed_mode`, and `token` must flag `token_balance` but NOT
// `tokenized_text`. A column name is split on `_` (and camelCase humps) into
// lowercase segments; the name is denied when any segment is a denylisted
// term or the full name contains a denylisted compound.

/** Single-segment financial terms (matched against snake/camel segments). */
export const FINANCIAL_FIELD_SEGMENTS: readonly string[] = [
  'wallet',
  'wallets',
  'payment',
  'payments',
  'paid',
  'donation',
  'donations',
  'donor',
  'donors',
  'treasury',
  'token',
  'tokens',
  'balance',
  'balances',
  'price',
  'prices',
  'fee',
  'fees',
  'payout',
  'payouts',
  'invoice',
  'invoices',
  'billing',
  'crypto',
  'currency',
  'knomosis',
  'grant',
  'grants',
  'bounty',
  'bounties',
  'membership',
  'sponsor',
  'sponsored',
  // WS-I.2.1b ranking-feature denylist additions (WS-A.1.1 prohibited
  // signals): follower counts and stake/vote weights are popularity/financial
  // signals that must never enter candidate retrieval or the feature store.
  'follower',
  'followers',
  'stake',
  'staked',
  'stakes',
];

/** Multi-segment compounds matched against the whole (lowercased) name. */
export const FINANCIAL_FIELD_COMPOUNDS: readonly string[] = [
  'amount_paid',
  'paid_amount',
  'tx_hash',
  'chain_id',
  // WS-I.2.1b ranking-feature denylist additions.
  'vote_weight',
  'membership_tier',
  'subscription_amount',
];

/** Split a column/field name into lowercase segments (snake_case + camelCase). */
export function fieldNameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0);
}

/**
 * Whether `name` (a column or documented JSONB sub-field name) is a financial
 * field per the shared denylist. Case-insensitive; segment-exact for single
 * terms, containment for compounds.
 */
export function isFinancialFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  if (FINANCIAL_FIELD_COMPOUNDS.some((compound) => lower.includes(compound))) return true;
  const segments = new Set(fieldNameSegments(name));
  return FINANCIAL_FIELD_SEGMENTS.some((term) => segments.has(term));
}

/**
 * Recursively collect every object-field name reachable in a zod schema —
 * the "documented JSONB sub-fields" input to the WS-F.2.5b content-schema
 * assertion (a financial field hidden inside a JSONB shape is still a
 * financial field). Walks objects, unions/discriminated unions, arrays,
 * optionals/nullables/defaults; record VALUE shapes are walked, record keys
 * are dynamic and validated by their own enum schemas.
 */
export function collectZodFieldNames(schema: unknown, into: Set<string> = new Set()): string[] {
  const node = schema as {
    def?: { type?: string };
    shape?: Record<string, unknown>;
    options?: unknown[];
    element?: unknown;
    unwrap?: () => unknown;
    valueType?: unknown;
  };
  const kind = node?.def?.type;
  if (kind === 'object' && node.shape) {
    for (const [key, child] of Object.entries(node.shape)) {
      into.add(key);
      collectZodFieldNames(child, into);
    }
  } else if ((kind === 'union' || kind === 'discriminatedUnion') && node.options) {
    for (const option of node.options) collectZodFieldNames(option, into);
  } else if (kind === 'array' && node.element) {
    collectZodFieldNames(node.element, into);
  } else if (
    (kind === 'optional' || kind === 'nullable' || kind === 'default' || kind === 'readonly') &&
    node.unwrap
  ) {
    collectZodFieldNames(node.unwrap(), into);
  } else if (kind === 'record' && node.valueType) {
    collectZodFieldNames(node.valueType, into);
  }
  return [...into];
}
