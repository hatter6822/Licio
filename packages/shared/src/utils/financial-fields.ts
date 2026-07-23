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
  // Compound containment runs against the NORMALIZED segment join (not the raw
  // lowercased name), so a camelCase compound (txHash → tx_hash) cannot evade the
  // backstop — and it stays consistent with `matchedFinancialPattern`, which uses
  // the same normalization (a divergence there throws as a drift guard).
  const segmentList = fieldNameSegments(name);
  const normalized = segmentList.join('_');
  if (FINANCIAL_FIELD_COMPOUNDS.some((compound) => normalized.includes(compound))) return true;
  const segments = new Set(segmentList);
  return FINANCIAL_FIELD_SEGMENTS.some((term) => segments.has(term));
}

/**
 * Zod node kinds that are LEAVES for this walk: none of them can contain an
 * object field name, so reaching one ends that branch with nothing to collect.
 * Kept explicit (rather than implied by "no handler matched") because the two
 * cases must be distinguishable — see {@link collectZodFieldNames}.
 */
const ZOD_LEAF_KINDS: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'date',
  'literal',
  'enum',
  'null',
  'undefined',
  'any',
  'unknown',
  'never',
  'void',
  'nan',
  'symbol',
  'file',
  'template_literal',
  // `z.custom` carries a user predicate, not a shape — nothing to walk.
  'custom',
  // The `out` half of a `.transform()` pipe: it holds the transform FUNCTION,
  // not a schema. The declared input shape is the `in` half, which IS walked.
  'transform',
]);

/** Structural view of the zod internals this walk reads (zod v4 `def` shapes). */
interface ZodNodeLike {
  def?: {
    type?: string;
    items?: unknown[];
    rest?: unknown;
    left?: unknown;
    right?: unknown;
    in?: unknown;
    out?: unknown;
    getter?: () => unknown;
    innerType?: unknown;
    keyType?: unknown;
    valueType?: unknown;
  };
  shape?: Record<string, unknown>;
  options?: unknown[];
  element?: unknown;
  unwrap?: () => unknown;
  valueType?: unknown;
}

/**
 * Recursively collect every object-field name reachable in a zod schema —
 * the "documented JSONB sub-fields" input to the WS-F.2.5b content-schema
 * assertion (a financial field hidden inside a JSONB shape is still a
 * financial field), and the WS-I.2.1b feature-schema audit.
 *
 * TOTAL BY CONSTRUCTION. Every node is either walked, a declared leaf
 * ({@link ZOD_LEAF_KINDS}), or an error. A walker that silently returned `[]`
 * for a shape it did not recognize would make BOTH gates pass VACUOUSLY — a
 * financial field wrapped in an unhandled combinator (or in any node zod renames
 * in a future major) would simply never be looked at, and the "no pay-to-rank"
 * proof would quietly stop proving anything. Throwing converts that drift into a
 * red test naming the kind and the path instead.
 *
 * Cycles (`z.lazy` recursive schemas) terminate on the `visited` identity set.
 * Record/map KEYS are not collected: they are dynamic and constrained by their
 * own key schema, so their value shapes are what carry field names.
 */
export function collectZodFieldNames(
  schema: unknown,
  into: Set<string> = new Set(),
  path = '$',
  visited: Set<unknown> = new Set(),
): string[] {
  if (schema === null || typeof schema !== 'object') return [...into];
  if (visited.has(schema)) return [...into];
  visited.add(schema);

  const node = schema as ZodNodeLike;
  const kind = node.def?.type;
  const walk = (child: unknown, childPath: string): void => {
    collectZodFieldNames(child, into, childPath, visited);
  };

  switch (kind) {
    case 'object':
      for (const [key, child] of Object.entries(node.shape ?? {})) {
        into.add(key);
        walk(child, `${path}.${key}`);
      }
      break;
    // Discriminated unions report `type: 'union'` in zod v4; the explicit case
    // keeps the walk correct if that ever diverges again.
    case 'union':
    case 'discriminatedUnion':
      (node.options ?? []).forEach((option, index) => {
        walk(option, `${path}|${index}`);
      });
      break;
    case 'array':
      walk(node.element, `${path}[]`);
      break;
    case 'tuple':
      (node.def?.items ?? []).forEach((item, index) => {
        walk(item, `${path}[${index}]`);
      });
      if (node.def?.rest !== undefined && node.def.rest !== null) {
        walk(node.def.rest, `${path}[...]`);
      }
      break;
    case 'intersection':
      walk(node.def?.left, `${path}&left`);
      walk(node.def?.right, `${path}&right`);
      break;
    // `.transform()` and `.pipe()` share the `pipe` kind: both ends are walked
    // so a shape on either side of the transform is still audited.
    case 'pipe':
      walk(node.def?.in, `${path}>in`);
      walk(node.def?.out, `${path}>out`);
      break;
    case 'lazy':
      walk(node.def?.getter?.(), `${path}~lazy`);
      break;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'nonoptional':
    case 'catch':
    case 'promise':
      walk(node.unwrap?.() ?? node.def?.innerType, path);
      break;
    case 'record':
    case 'map':
      walk(node.valueType ?? node.def?.valueType, `${path}{}`);
      break;
    case 'set':
      walk(node.def?.valueType, `${path}<>`);
      break;
    default:
      if (kind !== undefined && !ZOD_LEAF_KINDS.has(kind)) {
        throw new Error(
          `collectZodFieldNames: unrecognized zod node "${kind}" at ${path} — the financial-field ` +
            'walk cannot prove this subtree is clean; add a case (or a leaf entry) for it.',
        );
      }
  }
  return [...into];
}
