// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.2.5b / WS-I.2.1b — the shared financial-field denylist and the zod field
// walk behind the no-pay-to-rank structural guarantee.  The walk is the load
// bearing half: `checkContentFinancialDenylist` and the ranking-neutrality audit
// both prove "no financial field exists" by matching the names this function
// returns, so a shape it fails to descend into is a shape the gates never
// inspect.  These tests pin BOTH halves of that contract — every container kind
// is descended, and an unrecognized node is a loud failure rather than an empty
// (vacuously clean) result.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  collectZodFieldNames,
  FINANCIAL_FIELD_COMPOUNDS,
  FINANCIAL_FIELD_SEGMENTS,
  fieldNameSegments,
  isFinancialFieldName,
} from '../utils/financial-fields.js';

describe('fieldNameSegments', () => {
  it('splits snake_case, camelCase, and mixed separators into lowercase segments', () => {
    expect(fieldNameSegments('entry_fee')).toEqual(['entry', 'fee']);
    expect(fieldNameSegments('txHash')).toEqual(['tx', 'hash']);
    expect(fieldNameSegments('walletAccountId')).toEqual(['wallet', 'account', 'id']);
    expect(fieldNameSegments('Payment-Intent.id')).toEqual(['payment', 'intent', 'id']);
    expect(fieldNameSegments('')).toEqual([]);
  });
});

describe('isFinancialFieldName', () => {
  it('matches a denylisted term as a whole SEGMENT, not a substring', () => {
    expect(isFinancialFieldName('entry_fee')).toBe(true);
    expect(isFinancialFieldName('token_balance')).toBe(true);
    // The documented near-misses the segment rule exists to protect.
    expect(isFinancialFieldName('feed_mode')).toBe(false);
    expect(isFinancialFieldName('tokenized_text')).toBe(false);
  });

  it('matches compounds through the NORMALIZED join, so camelCase cannot evade it', () => {
    expect(isFinancialFieldName('tx_hash')).toBe(true);
    expect(isFinancialFieldName('txHash')).toBe(true);
    expect(isFinancialFieldName('chainId')).toBe(true);
    expect(isFinancialFieldName('voteWeight')).toBe(true);
  });

  it('flags every listed segment and compound (the list is live, not decorative)', () => {
    for (const term of FINANCIAL_FIELD_SEGMENTS) {
      expect(isFinancialFieldName(`some_${term}_field`), term).toBe(true);
    }
    for (const compound of FINANCIAL_FIELD_COMPOUNDS) {
      expect(isFinancialFieldName(compound), compound).toBe(true);
    }
  });

  it('clears ordinary content field names', () => {
    for (const name of ['title', 'body', 'created_at', 'author_handle', 'thread_id']) {
      expect(isFinancialFieldName(name), name).toBe(false);
    }
  });
});

describe('collectZodFieldNames — descends every container kind', () => {
  // Each case hides a DENYLISTED name one level down inside the container under
  // test: if the walk does not descend, the name is missing and the gate that
  // consumes these names would pass while the financial field sits there.
  // `unknown` for the schema slot: `collectZodFieldNames` accepts `unknown` by
  // design, and a `z.ZodType` annotation would unify every entry's INPUT type
  // against the first one's.
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ['object', z.object({ nested: z.object({ wallet: z.string() }) }), 'wallet'],
    ['array', z.object({ list: z.array(z.object({ tx_hash: z.string() })) }), 'tx_hash'],
    ['optional', z.object({ o: z.object({ price: z.number() }).optional() }), 'price'],
    ['nullable', z.object({ n: z.object({ fee: z.number() }).nullable() }), 'fee'],
    [
      'default',
      z.object({ d: z.object({ balance: z.number() }).default({ balance: 0 }) }),
      'balance',
    ], // prettier-ignore
    ['readonly', z.object({ r: z.object({ payout: z.number() }).readonly() }), 'payout'],
    ['prefault', z.object({ p: z.object({ donor: z.string() }).prefault({ donor: '' }) }), 'donor'],
    [
      'nonoptional',
      z.object({ q: z.object({ token: z.string() }).optional().nonoptional() }),
      'token',
    ], // prettier-ignore
    ['catch', z.object({ c: z.object({ grant: z.number() }).catch({ grant: 0 }) }), 'grant'],
    ['union', z.union([z.object({ plain: z.string() }), z.object({ stake: z.string() })]), 'stake'],
    ['record', z.object({ m: z.record(z.string(), z.object({ invoice: z.number() })) }), 'invoice'],
    ['tuple', z.tuple([z.object({ bounty: z.string() })]), 'bounty'],
    ['tuple rest', z.tuple([z.string()], z.object({ sponsor: z.string() })), 'sponsor'],
    [
      'intersection',
      z.intersection(z.object({ a: z.string() }), z.object({ billing: z.string() })),
      'billing',
    ], // prettier-ignore
    // The pipe TARGET must accept the source's output, so the financial field is
    // added as an optional on the `out` half — which is the half being tested.
    [
      'pipe',
      z
        .object({ a: z.string() })
        .pipe(z.object({ a: z.string(), currency: z.string().optional() })),
      'currency',
    ], // prettier-ignore
    ['transform', z.object({ crypto: z.string() }).transform((v) => v), 'crypto'],
    ['map', z.map(z.string(), z.object({ payments: z.string() })), 'payments'],
    ['set', z.set(z.object({ treasury: z.string() })), 'treasury'],
    ['promise', z.promise(z.object({ donation: z.string() })), 'donation'],
  ];

  for (const [label, schema, hidden] of cases) {
    it(`descends ${label} and surfaces the hidden financial field`, () => {
      const names = collectZodFieldNames(schema);
      expect(names).toContain(hidden);
      expect(names.filter((name) => isFinancialFieldName(name))).toContain(hidden);
    });
  }

  it('descends a discriminated union into every branch', () => {
    const names = collectZodFieldNames(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), donor: z.string() }),
        z.object({ kind: z.literal('b'), plain: z.string() }),
      ]),
    );
    expect(names).toEqual(expect.arrayContaining(['kind', 'donor', 'plain']));
  });

  it('terminates on a recursive z.lazy schema and still collects its fields', () => {
    const node: z.ZodType = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(node), fees: z.number() }),
    );
    expect(collectZodFieldNames(node)).toEqual(
      expect.arrayContaining(['name', 'children', 'fees']),
    );
  });

  it('treats scalar leaves as empty rather than as unrecognized', () => {
    for (const leaf of [
      z.string(),
      z.number(),
      z.boolean(),
      z.date(),
      z.literal('x'),
      z.enum(['a']),
      z.any(),
      z.unknown(),
      z.never(),
      z.null(),
      z.undefined(),
      z.bigint(),
      z.nan(),
      z.symbol(),
      z.void(),
      z.custom(() => true),
    ]) {
      // prettier-ignore
      expect(collectZodFieldNames(leaf)).toEqual([]);
    }
  });

  it('ignores non-schema input instead of throwing', () => {
    expect(collectZodFieldNames(null)).toEqual([]);
    expect(collectZodFieldNames(undefined)).toEqual([]);
    expect(collectZodFieldNames({ not: 'a schema' })).toEqual([]);
  });
});

describe('collectZodFieldNames — fails LOUDLY on an unrecognized node', () => {
  // The whole point of the throw: a walker that returned [] for a shape it did
  // not understand would make both no-pay-to-rank gates report "clean" without
  // having looked. A zod major that renames a node kind must break the gate.
  it('throws with the node kind and the path', () => {
    expect(() => collectZodFieldNames({ def: { type: 'some_future_kind' } })).toThrowError(
      /unrecognized zod node "some_future_kind" at \$/,
    );
  });

  it('reports the PATH of the offending node, not just the root', () => {
    expect(() =>
      collectZodFieldNames(
        z.object({ outer: z.object({ inner: { def: { type: 'mystery' } } as never }) }),
      ),
    ).toThrowError(/at \$\.outer\.inner/);
  });
});
