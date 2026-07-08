// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  assertContextsClassified,
  checkSchemaIsolation,
  FK_INTROSPECTION_SQL,
  type IntrospectionRow,
  ISOLATION_CONTEXTS,
  type IsolationContexts,
  introspectEventPartitions,
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
  it('classify wallet.wallet_accounts and the WS-E ranking/attention tables', () => {
    expect(ISOLATION_CONTEXTS.walletTables.has('wallet.wallet_accounts')).toBe(true);
    // WS-E.3.1: the ranking context is populated, so the BFS proof is active
    // (no longer trivially true). Every event/attention/scoring table is a
    // target the wallet context must not reach.
    for (const table of [
      'public.events',
      'public.attention_aggregates',
      'public.aggregation_windows',
      'public.invariant_outputs',
      'public.signal_ledger_entries',
      'public.item_safety_states',
    ]) {
      expect(ISOLATION_CONTEXTS.rankingTables.has(table), `${table} classified`).toBe(true);
    }
  });

  it('hold isolation for the current WS-D + WS-E graph', () => {
    // Every WS-D table references only the identity root; the WS-E tables that
    // carry an owner FK also reference only `users` — which is an articulation
    // node (reachable, never transitable), so the wallet context still cannot
    // reach any ranking table.
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: 'wallet.wallet_accounts', to: USERS },
        { from: 'public.sessions', to: USERS },
        { from: 'public.wallet_auth_credentials', to: USERS },
        { from: 'public.user_auth', to: USERS },
        { from: 'public.webauthn_credentials', to: USERS },
        { from: 'public.audit_log', to: USERS },
        { from: 'public.events', to: USERS },
        { from: 'public.signal_ledger_entries', to: USERS },
      ],
      views: [],
    };
    expect(checkSchemaIsolation(graph, ISOLATION_CONTEXTS).isolated).toBe(true);
  });

  it('fails if a view ever bridges a wallet table to a WS-E ranking table', () => {
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: 'wallet.wallet_accounts', to: USERS },
        { from: 'public.events', to: USERS },
      ],
      views: [
        {
          view: 'public.v_wallet_attention',
          dependsOn: ['wallet.wallet_accounts', 'public.attention_aggregates'],
        },
      ],
    };
    const result = checkSchemaIsolation(graph, ISOLATION_CONTEXTS);
    expect(result.isolated).toBe(false);
  });
});

describe('WS-U knomosis governance context isolation', () => {
  const KNOMOSIS = [
    'knomosis.room_steward_seat',
    'knomosis.steward_election',
    'knomosis.steward_governance_vote',
    'knomosis.room_governance_model',
    'knomosis.room_governance_prompt',
    'knomosis.room_law_pack',
    'knomosis.room_agent_binding',
    'knomosis.agent_action_log',
    'knomosis.agent_treasury_action',
  ];

  it('classifies every knomosis governance table into the wallet/Knomosis context', () => {
    for (const table of KNOMOSIS) {
      expect(ISOLATION_CONTEXTS.walletTables.has(table), `${table} classified`).toBe(true);
    }
  });

  it('holds isolation for the real governance FK shape (users + intra-knomosis only)', () => {
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: 'wallet.wallet_accounts', to: USERS },
        { from: 'knomosis.room_steward_seat', to: USERS },
        { from: 'knomosis.steward_election', to: USERS },
        { from: 'knomosis.steward_governance_vote', to: 'knomosis.steward_election' },
        { from: 'knomosis.steward_governance_vote', to: USERS },
        { from: 'knomosis.room_governance_model', to: USERS },
        { from: 'knomosis.room_governance_prompt', to: 'knomosis.room_governance_model' },
        { from: 'knomosis.room_governance_prompt', to: USERS },
        { from: 'knomosis.room_agent_binding', to: 'knomosis.room_governance_model' },
        { from: 'knomosis.room_agent_binding', to: 'knomosis.room_governance_prompt' },
        { from: 'knomosis.room_agent_binding', to: 'knomosis.room_law_pack' },
        // Ranking/content tables independently reference the identity root.
        { from: 'public.rooms', to: USERS },
        { from: 'public.contributions', to: USERS },
      ],
      views: [],
    };
    expect(checkSchemaIsolation(graph, ISOLATION_CONTEXTS).isolated).toBe(true);
  });

  it('would fail if a governance table ever hard-referenced a ranking table', () => {
    const graph: SchemaGraph = {
      foreignKeys: [{ from: 'knomosis.room_steward_seat', to: 'public.rooms' }],
      views: [],
    };
    const result = checkSchemaIsolation(graph, ISOLATION_CONTEXTS);
    expect(result.isolated).toBe(false);
    expect(result.offendingPath).toContain('public.rooms');
  });
});

describe('WS-L knomosis gateway/wallets context isolation (migration 0059)', () => {
  const KNOMOSIS_L = [
    'knomosis.knomosis_deployment',
    'knomosis.on_chain_event',
    'knomosis.knomosis_action_record',
    'knomosis.knomosis_action_nonce',
    'knomosis.wallet_actor_mapping',
    'knomosis.governance_proposal',
    'knomosis.governance_proposal_vote',
    'knomosis.governance_signature',
    'knomosis.sim_treasury',
    'knomosis.sim_treasury_entry',
    'knomosis.governance_audit_log',
    'knomosis.knomosis_reconciliation_result',
    'knomosis.knomosis_receipt',
    'knomosis.comprehension_result',
  ];

  it('classifies every WS-L financial table into the wallet/Knomosis context', () => {
    for (const table of KNOMOSIS_L) {
      expect(ISOLATION_CONTEXTS.walletTables.has(table), `${table} classified`).toBe(true);
    }
  });

  it('holds isolation for the real WS-L FK shape (users + intra-context only)', () => {
    // The genuine hard FKs the WS-L schema declares (migration 0059): each is
    // either to public.users (the articulation root) or WITHIN the wallet/
    // knomosis context.  Room/content references are SOFT (bare uuid, no FK).
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: 'knomosis.on_chain_event', to: 'knomosis.knomosis_deployment' },
        { from: 'knomosis.knomosis_action_record', to: 'knomosis.knomosis_deployment' },
        { from: 'knomosis.knomosis_action_record', to: 'wallet.wallet_accounts' },
        { from: 'knomosis.knomosis_action_record', to: USERS },
        { from: 'knomosis.knomosis_action_record', to: 'knomosis.on_chain_event' },
        { from: 'knomosis.knomosis_action_nonce', to: USERS },
        { from: 'knomosis.knomosis_action_nonce', to: 'knomosis.knomosis_deployment' },
        { from: 'knomosis.wallet_actor_mapping', to: 'wallet.wallet_accounts' },
        { from: 'knomosis.wallet_actor_mapping', to: 'knomosis.knomosis_deployment' },
        { from: 'knomosis.governance_proposal', to: USERS },
        { from: 'knomosis.governance_proposal_vote', to: 'knomosis.governance_proposal' },
        { from: 'knomosis.governance_proposal_vote', to: USERS },
        { from: 'knomosis.governance_signature', to: 'knomosis.governance_proposal' },
        { from: 'knomosis.governance_signature', to: 'wallet.wallet_accounts' },
        { from: 'knomosis.governance_signature', to: USERS },
        { from: 'knomosis.sim_treasury_entry', to: USERS },
        { from: 'knomosis.sim_treasury_entry', to: 'knomosis.governance_proposal' },
        { from: 'knomosis.governance_audit_log', to: USERS },
        { from: 'knomosis.knomosis_reconciliation_result', to: 'knomosis.knomosis_deployment' },
        { from: 'knomosis.knomosis_receipt', to: 'knomosis.knomosis_action_record' },
        { from: 'knomosis.knomosis_receipt', to: USERS },
        { from: 'knomosis.comprehension_result', to: USERS },
        // Ranking/content tables independently reference the identity root.
        { from: 'public.rooms', to: USERS },
        { from: 'public.ranking_feature_vectors', to: USERS },
      ],
      views: [],
    };
    expect(checkSchemaIsolation(graph, ISOLATION_CONTEXTS).isolated).toBe(true);
  });

  it('would fail if a WS-L standing/action table ever hard-referenced a ranking table', () => {
    // A deliberately-added FK from the gateway standing surface to the ranking
    // feature store — the exact pay-to-rank bridge the firewall forbids.
    const graph: SchemaGraph = {
      foreignKeys: [
        { from: 'knomosis.wallet_actor_mapping', to: 'public.ranking_feature_vectors' },
      ],
      views: [],
    };
    const result = checkSchemaIsolation(graph, ISOLATION_CONTEXTS);
    expect(result.isolated).toBe(false);
    expect(result.offendingPath).toContain('public.ranking_feature_vectors');
  });

  it('would fail if a view ever joined a WS-L balance table to a ranking table', () => {
    const graph: SchemaGraph = {
      foreignKeys: [],
      views: [
        {
          view: 'public.pay_to_rank_view',
          dependsOn: ['knomosis.knomosis_action_record', 'public.attention_aggregates'],
        },
      ],
    };
    const result = checkSchemaIsolation(graph, ISOLATION_CONTEXTS);
    expect(result.isolated).toBe(false);
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

describe('partition classification parity (WS-E.3.1 migrations)', () => {
  it('every `events` partition created by a migration is a classified ranking table', async () => {
    // Postgres exposes partitions as ordinary relations a view or FK can
    // target DIRECTLY, so each must be a BFS target in its own right — a
    // wallet→partition bridge must never evade the proof by hitting a
    // partition the allowlist forgot. Parsed from the shipped migrations so
    // adding a partition without classifying it fails here.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const migrationsDir = join(import.meta.dirname, '../../drizzle');
    const partitions = new Set<string>();
    for (const file of await readdir(migrationsDir)) {
      if (!file.endsWith('.sql')) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      for (const match of sql.matchAll(/CREATE TABLE "([^"]+)" PARTITION OF "events"/g)) {
        if (match[1]) partitions.add(`public.${match[1]}`);
      }
    }
    expect(partitions.size).toBeGreaterThanOrEqual(8);
    for (const partition of partitions) {
      expect(ISOLATION_CONTEXTS.rankingTables.has(partition)).toBe(true);
    }
    // And the parent itself stays classified.
    expect(ISOLATION_CONTEXTS.rankingTables.has('public.events')).toBe(true);
  });
});

describe('introspectEventPartitions', () => {
  it('maps live partition rows to qualified relations', async () => {
    const partitions = await introspectEventPartitions(async () => [
      { child_schema: 'public', child_table: 'events_attention_aggregated' },
      { child_schema: 'public', child_table: 'events_default' },
    ]);
    expect(partitions).toEqual(['public.events_attention_aggregated', 'public.events_default']);
  });
});
