// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Schema-isolation verification (WS-D.3.2) — the structural enforcement of the
// "no pay-to-rank" invariant (§17.1, §21.5).  It proves that NO SQL join path
// exists between the wallet/Knomosis bounded context and the ranking/attention
// bounded context.
//
// The foreign-key + view-dependency graph is treated as UNDIRECTED (an attacker
// can traverse a join either way).  A breadth-first search seeds from every wallet
// table and fails if it reaches any ranking/attention table.  `public.users` is
// the single permitted articulation point: BFS may REACH it (both contexts
// legitimately reference the identity root) but never TRANSITS through it, so a
// wallet→users→ranking walk is not a "join path".  A direct wallet↔ranking edge,
// a multi-hop bridge, or a view joining the two IS caught.
//
// Classification is FAIL-CLOSED: every table living in a wallet or ranking schema
// must be explicitly classified, so smuggling a cross-context table in as
// "unclassified" cannot slip past the check.

/** A fully-qualified relation name, e.g. `wallet.wallet_accounts` or `public.users`. */
export type Relation = string;

export interface SchemaGraph {
  /** Directed FK edges: `from` (referencing table) → `to` (referenced table). */
  foreignKeys: Array<{ from: Relation; to: Relation }>;
  /** View dependencies: a view and every relation it reads from. */
  views: Array<{ view: Relation; dependsOn: Relation[] }>;
}

export interface IsolationContexts {
  /** Allowlist of every table in the wallet/Knomosis context. */
  walletTables: ReadonlySet<Relation>;
  /** Allowlist of every table in the ranking/attention context. */
  rankingTables: ReadonlySet<Relation>;
  /** Permitted articulation points (reached but never transited).  Default: public.users. */
  articulationNodes?: ReadonlySet<Relation>;
}

export interface IsolationResult {
  isolated: boolean;
  /** On failure, a human-readable path `a → b → …` for fast diagnosis. */
  offendingPath?: Relation[];
}

const DEFAULT_ARTICULATION: ReadonlySet<Relation> = new Set(['public.users']);

// ---------------------------------------------------------------------------
// The explicit per-context allowlists (WS-D.3.2 / WS-E.3.1).  The ranking
// context now lists every WS-E event/attention/scoring table, so the BFS proof
// actively verifies the wallet↔ranking separation rather than passing
// trivially.  Adding a wallet/ranking table without listing it here fails
// `assertContextsClassified` (fail-closed).
// ---------------------------------------------------------------------------

/**
 * Wallet/Knomosis bounded-context tables: the financial wallet plus the WS-U
 * AI-governed-rooms governance/treasury tables in the `knomosis` schema. Each is
 * a BFS seed of the pay-to-rank isolation proof — none may reach a ranking table.
 * They reference `public.rooms`/content only by SOFT ref (no FK), so the only
 * hard outward edge is to `public.users` (the articulation node).
 */
export const WALLET_CONTEXT_TABLES: ReadonlySet<Relation> = new Set([
  'wallet.wallet_accounts',
  'knomosis.room_steward_seat',
  'knomosis.steward_election',
  'knomosis.steward_governance_vote',
  'knomosis.room_governance_model',
  'knomosis.room_governance_prompt',
  'knomosis.model_ratification',
  'knomosis.model_ratification_ballot',
  'knomosis.room_law_pack',
  'knomosis.room_agent_binding',
  'knomosis.agent_action_log',
  'knomosis.agent_treasury_action',
  // WS-L Knomosis gateway, wallets, and receipts (migration 0059).  Every new
  // financial table is a BFS seed of the pay-to-rank isolation proof.
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
]);

/**
 * Ranking/attention bounded-context tables (WS-E.3.1).  These are the BFS
 * targets of the pay-to-rank isolation proof: no FK/view join path may connect
 * them to the wallet context (transiting `public.users` does not count — it is
 * an articulation node that may be reached but never crossed).
 */
export const RANKING_CONTEXT_TABLES: ReadonlySet<Relation> = new Set<Relation>([
  'public.events',
  // The concrete per-tier partitions of `events` (migration 0003).  Postgres
  // exposes partitions as ordinary relations, so a view or FK could target one
  // DIRECTLY — each must therefore be a BFS target in its own right, or a
  // wallet→partition bridge would evade the proof.  A migration-parity test
  // asserts this list covers every `PARTITION OF "events"` in the migrations.
  'public.events_attention_raw',
  'public.events_attention_aggregated',
  'public.events_public_contribution',
  'public.events_ranking_log',
  'public.events_moderation_legal',
  'public.events_account_active',
  'public.events_security_log',
  'public.events_default',
  'public.attention_aggregates',
  'public.aggregation_windows',
  'public.invariant_outputs',
  'public.signal_ledger_entries',
  'public.item_safety_states',
  'public.pwatt_config',
  'public.event_dead_letters',
  'public.consumer_checkpoints',
  // WS-F content/ingestion/search tables (WS-F.2.5b): everything stories,
  // claims, sources, evidence, search, and embeddings touch feeds ranking, so
  // each is a BFS target of the pay-to-rank isolation proof — no FK/view join
  // path may connect them to the wallet context.
  'public.stories',
  'public.story_lifecycle_audits',
  'public.story_signatures',
  'public.story_lsh_bands',
  'public.story_source_links',
  'public.story_freshness',
  'public.sources',
  'public.source_syndications',
  'public.claims',
  'public.evidence_cards',
  'public.threads',
  'public.takedown_requests',
  'public.ingestion_review_items',
  'public.embeddings',
  // WS-G forum content (contributions, rooms, lenses, uploads).
  'public.contributions',
  'public.contribution_edit_history',
  'public.rooms',
  'public.room_stewards',
  'public.room_subscriptions',
  'public.lenses',
  'public.uploads',
  // WS-I ranking (the feature store and the decision-log audit record):
  // THE pay-to-rank surfaces — no FK/view join path may ever connect them
  // to the wallet context.
  'public.ranking_feature_vectors',
  'public.ranking_decision_logs',
]);

/** Schemas whose every table must be classified into a context (fail-closed). */
export const CONTEXT_SCHEMAS: readonly string[] = ['wallet', 'knomosis'];

/** The canonical isolation contexts consumed by the CI test (WS-D.3.2). */
export const ISOLATION_CONTEXTS: IsolationContexts = {
  walletTables: WALLET_CONTEXT_TABLES,
  rankingTables: RANKING_CONTEXT_TABLES,
  articulationNodes: DEFAULT_ARTICULATION,
};

/** Build an undirected adjacency map from FK edges and view dependencies. */
function buildAdjacency(graph: SchemaGraph): Map<Relation, Set<Relation>> {
  const adj = new Map<Relation, Set<Relation>>();
  const link = (a: Relation, b: Relation): void => {
    (adj.get(a) ?? adj.set(a, new Set()).get(a))?.add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b))?.add(a);
  };
  for (const { from, to } of graph.foreignKeys) link(from, to);
  for (const { view, dependsOn } of graph.views) {
    for (const dep of dependsOn) link(view, dep);
  }
  return adj;
}

/**
 * Verify the wallet and ranking contexts share no join path.  Returns
 * `isolated: true` when none exists, or the offending path on the first breach.
 */
export function checkSchemaIsolation(
  graph: SchemaGraph,
  contexts: IsolationContexts,
): IsolationResult {
  const articulation = contexts.articulationNodes ?? DEFAULT_ARTICULATION;
  const adj = buildAdjacency(graph);

  // BFS from the union of all wallet tables, tracking the path for diagnostics.
  const visited = new Set<Relation>();
  const queue: Relation[] = [];
  const parent = new Map<Relation, Relation | null>();
  for (const seed of contexts.walletTables) {
    visited.add(seed);
    parent.set(seed, null);
    queue.push(seed);
  }

  while (queue.length > 0) {
    const node = queue.shift() as Relation;

    if (contexts.rankingTables.has(node)) {
      return { isolated: false, offendingPath: reconstructPath(parent, node) };
    }

    // An articulation node may be REACHED but its neighbours are never explored,
    // so a wallet→users→ranking walk does not count as a join path.  Seeds are an
    // exception (a seed that is also articulation must still expand outward).
    if (articulation.has(node) && !contexts.walletTables.has(node)) continue;

    for (const neighbour of adj.get(node) ?? []) {
      if (!visited.has(neighbour)) {
        visited.add(neighbour);
        parent.set(neighbour, node);
        queue.push(neighbour);
      }
    }
  }

  return { isolated: true };
}

function reconstructPath(parent: Map<Relation, Relation | null>, end: Relation): Relation[] {
  const path: Relation[] = [];
  let current: Relation | null | undefined = end;
  while (current != null) {
    path.unshift(current);
    current = parent.get(current);
  }
  return path;
}

export interface ClassificationResult {
  classified: boolean;
  /** Tables found in a wallet/ranking schema that no allowlist claims. */
  unclassified: Relation[];
}

/**
 * Fail-closed classification check: every relation whose schema is one of the
 * context schemas MUST appear in the corresponding allowlist.  An unclassified
 * table (a new table added without classifying it) fails the check.
 */
export function assertContextsClassified(
  actualRelations: readonly Relation[],
  contexts: IsolationContexts,
  contextSchemas: readonly string[],
): ClassificationResult {
  const claimed = new Set<Relation>([...contexts.walletTables, ...contexts.rankingTables]);
  const unclassified = actualRelations.filter((rel) => {
    const schema = rel.split('.')[0] ?? '';
    return contextSchemas.includes(schema) && !claimed.has(rel);
  });
  return { classified: unclassified.length === 0, unclassified };
}

// ---------------------------------------------------------------------------
// Live introspection (gated integration use).  `runQuery` is injected so the
// assembler is unit-testable with a fake row source and has no hard dependency on
// a live connection.
// ---------------------------------------------------------------------------

export interface IntrospectionRow {
  [column: string]: string | null;
}
export type QueryRunner = (sql: string) => Promise<IntrospectionRow[]>;

/** SQL that lists every foreign-key edge as (from_schema, from_table, to_schema, to_table). */
export const FK_INTROSPECTION_SQL = `
  SELECT
    tc.table_schema  AS from_schema,
    tc.table_name    AS from_table,
    ccu.table_schema AS to_schema,
    ccu.table_name   AS to_table
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON rc.unique_constraint_name = ccu.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY';
`;

/** SQL that lists view → referenced-relation dependencies. */
export const VIEW_INTROSPECTION_SQL = `
  SELECT DISTINCT
    vtu.view_schema   AS view_schema,
    vtu.view_name     AS view_name,
    vtu.table_schema  AS dep_schema,
    vtu.table_name    AS dep_table
  FROM information_schema.view_table_usage vtu;
`;

/**
 * SQL that lists the LIVE concrete partitions of `public.events`.  Postgres
 * exposes partitions as ordinary relations a view or FK can target directly,
 * and the `public` schema cannot be wholly fail-closed (it also holds
 * identity tables), so the gated integration test asserts every live
 * partition is a classified ranking table — the runtime complement of the
 * static migration-parity test.
 */
export const EVENT_PARTITION_INTROSPECTION_SQL = `
  SELECT cn.nspname AS child_schema, c.relname AS child_table
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_namespace cn ON cn.oid = c.relnamespace
  JOIN pg_class p ON p.oid = i.inhparent
  JOIN pg_namespace pn ON pn.oid = p.relnamespace
  WHERE pn.nspname = 'public' AND p.relname = 'events';
`;

/** The live `events` partitions as qualified relations (gated integration). */
export async function introspectEventPartitions(runQuery: QueryRunner): Promise<Relation[]> {
  const rows = await runQuery(EVENT_PARTITION_INTROSPECTION_SQL);
  return rows.map((r) => `${r['child_schema']}.${r['child_table']}`);
}

/** Assemble a {@link SchemaGraph} from a live database via the injected runner. */
export async function introspectSchemaGraph(runQuery: QueryRunner): Promise<SchemaGraph> {
  const fkRows = await runQuery(FK_INTROSPECTION_SQL);
  const viewRows = await runQuery(VIEW_INTROSPECTION_SQL);
  const foreignKeys = fkRows.map((r) => ({
    from: `${r['from_schema']}.${r['from_table']}`,
    to: `${r['to_schema']}.${r['to_table']}`,
  }));
  const viewMap = new Map<Relation, Set<Relation>>();
  for (const r of viewRows) {
    const view = `${r['view_schema']}.${r['view_name']}`;
    const dep = `${r['dep_schema']}.${r['dep_table']}`;
    (viewMap.get(view) ?? viewMap.set(view, new Set()).get(view))?.add(dep);
  }
  const views = [...viewMap.entries()].map(([view, deps]) => ({ view, dependsOn: [...deps] }));
  return { foreignKeys, views };
}
