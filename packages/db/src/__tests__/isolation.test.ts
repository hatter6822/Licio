// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  assertContextsClassified,
  checkSchemaIsolation,
  FK_INTROSPECTION_SQL,
  type IntrospectionRow,
  ISOLATION_CONTEXTS,
  type IsolationContexts,
  introspectSchemaGraph,
  type SchemaGraph,
  VIEW_INTROSPECTION_SQL,
} from '../isolation.js';

const WALLET = 'wallet.wallet_accounts';
const RANKING = 'ranking.attention_aggregates';
const USERS = 'public.users';

const contexts = (over: Partial<IsolationContexts> = {}): IsolationContexts => ({
  walletTables: new Set([WALLET]),
  rankingTables: new Set([RANKING]),
  articulationNodes: new Set([USERS]),
  ...over,
});

describe('checkSchemaIsolation — isolation HOLDS', () => {
  it('passes when wallet and ranking only independently reference the identity root', () => {
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: WALLET, to: USERS },
        { from: RANKING, to: USERS },
        { from: 'public.sessions', to: USERS },
      ],
      views: [],
    };
    expect(checkSchemaIsolation(graph, contexts())).toEqual({ isolated: true });
  });

  it('does NOT transit through the articulation node (wallet→users→ranking is not a join path)', () => {
    // Even though both reference users, users is reached but never expanded.
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: WALLET, to: USERS },
        { from: RANKING, to: USERS },
      ],
      views: [],
    };
    expect(checkSchemaIsolation(graph, contexts()).isolated).toBe(true);
  });
});

describe('checkSchemaIsolation — isolation BREACHED', () => {
  it('fails on a direct wallet → attention foreign key (with the offending path)', () => {
    const graph: SchemaGraph = { foreignKeys: [{ from: WALLET, to: RANKING }], views: [] };
    const result = checkSchemaIsolation(graph, contexts());
    expect(result.isolated).toBe(false);
    expect(result.offendingPath).toEqual([WALLET, RANKING]);
  });

  it('fails on an indirect 3-hop bridge', () => {
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: WALLET, to: 'wallet.wallet_meta' },
        { from: 'wallet.wallet_meta', to: 'public.bridge' },
        { from: 'public.bridge', to: RANKING },
      ],
      views: [],
    };
    const walletTables = new Set([WALLET, 'wallet.wallet_meta']);
    const result = checkSchemaIsolation(graph, contexts({ walletTables }));
    expect(result.isolated).toBe(false);
    // The path starts at SOME wallet-context table and terminates at the ranking table.
    expect(walletTables.has(result.offendingPath?.[0] as string)).toBe(true);
    expect(result.offendingPath?.at(-1)).toBe(RANKING);
  });

  it('fails on a VIEW that joins a wallet table and a ranking table', () => {
    const graph: SchemaGraph = {
      foreignKeys: [],
      views: [{ view: 'public.v_join', dependsOn: [WALLET, RANKING] }],
    };
    const result = checkSchemaIsolation(graph, contexts());
    expect(result.isolated).toBe(false);
    expect(result.offendingPath).toContain('public.v_join');
  });

  it('detects a breach regardless of FK direction (undirected traversal)', () => {
    const graph: SchemaGraph = { foreignKeys: [{ from: RANKING, to: WALLET }], views: [] };
    expect(checkSchemaIsolation(graph, contexts()).isolated).toBe(false);
  });
});

describe('assertContextsClassified — fail-closed', () => {
  it('passes when every wallet/ranking-schema table is classified', () => {
    const result = assertContextsClassified([WALLET, USERS, 'public.sessions'], contexts(), [
      'wallet',
      'ranking',
    ]);
    expect(result.classified).toBe(true);
    expect(result.unclassified).toEqual([]);
  });

  it('fails when a new wallet-schema table is not in any allowlist', () => {
    const result = assertContextsClassified([WALLET, 'wallet.new_unclassified'], contexts(), [
      'wallet',
      'ranking',
    ]);
    expect(result.classified).toBe(false);
    expect(result.unclassified).toEqual(['wallet.new_unclassified']);
  });

  it('ignores tables outside the context schemas (e.g. public identity tables)', () => {
    const result = assertContextsClassified(['public.user_auth', 'public.audit_log'], contexts(), [
      'wallet',
      'ranking',
    ]);
    expect(result.classified).toBe(true);
  });
});

describe('the SHIPPED isolation contexts', () => {
  it('classify wallet.wallet_accounts and leave ranking empty until WS-E', () => {
    expect(ISOLATION_CONTEXTS.walletTables.has('wallet.wallet_accounts')).toBe(true);
    expect(ISOLATION_CONTEXTS.rankingTables.size).toBe(0);
  });

  it('hold isolation for the current WS-D identity+wallet graph', () => {
    // Every WS-D table references only the identity root; no ranking tables yet.
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: 'wallet.wallet_accounts', to: USERS },
        { from: 'public.sessions', to: USERS },
        { from: 'public.wallet_auth_credentials', to: USERS },
        { from: 'public.user_auth', to: USERS },
        { from: 'public.webauthn_credentials', to: USERS },
        { from: 'public.audit_log', to: USERS },
      ],
      views: [],
    };
    expect(checkSchemaIsolation(graph, ISOLATION_CONTEXTS).isolated).toBe(true);
  });
});

describe('introspectSchemaGraph', () => {
  it('assembles FK and view edges from injected information_schema rows', async () => {
    const runQuery = async (sql: string): Promise<IntrospectionRow[]> => {
      if (sql === FK_INTROSPECTION_SQL) {
        return [
          {
            from_schema: 'wallet',
            from_table: 'wallet_accounts',
            to_schema: 'public',
            to_table: 'users',
          },
        ];
      }
      if (sql === VIEW_INTROSPECTION_SQL) {
        return [
          {
            view_schema: 'public',
            view_name: 'v_join',
            dep_schema: 'wallet',
            dep_table: 'wallet_accounts',
          },
          {
            view_schema: 'public',
            view_name: 'v_join',
            dep_schema: 'ranking',
            dep_table: 'attention_aggregates',
          },
        ];
      }
      return [];
    };
    const graph = await introspectSchemaGraph(runQuery);
    expect(graph.foreignKeys).toEqual([{ from: 'wallet.wallet_accounts', to: 'public.users' }]);
    expect(graph.views).toEqual([
      {
        view: 'public.v_join',
        dependsOn: ['wallet.wallet_accounts', 'ranking.attention_aggregates'],
      },
    ]);
  });
});
