// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Persona model for the DEV traffic simulator: behavioural archetypes plus the
// deterministic synthetic-user roster. Archetypes encode HOW a participant
// behaves (reading depth, posting cadence, return habits) as rates and bucket
// weightings the pure engine samples from; the roster pins WHO exists (fixed
// UUIDs in the reserved 5f5ed000 demo family, stable handles/names) so a
// re-boot against a durable dev database is idempotent. Account ages are
// deliberate: organic personas are backdated weeks so they read as normal aged
// accounts to the WS-E anti-signal trust weighting and the WS-F account-age
// gate, while the adversarial cluster is intentionally FRESH so the
// coordinated-burst scenario trips the real burst detectors.

import type { DwellBucket, ReplyDepthBucket, ReturnVisitBucket } from '@licio/shared';

/** Stable id factory for simulator users (the 5f5ed000 family is reserved for
 *  the simulator; demo-seed uses 5f5e0000–5f5ec000). */
export const SIM_USER_ID = (n: number): string =>
  `5f5ed000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export type PersonaArchetypeId =
  | 'author'
  | 'local_correspondent'
  | 'expert_author'
  | 'commenter'
  | 'evidence_contributor'
  | 'lurker'
  | 'skimmer'
  | 'deep_reader'
  | 'burst_returner'
  | 'reporter'
  | 'cluster_member'
  | 'newcomer';

/** A weighted option list the engine samples with prng.weighted. */
export type WeightedList<T> = ReadonlyArray<{ value: T; weight: number }>;

export interface PersonaArchetype {
  readonly id: PersonaArchetypeId;
  /** Base action rates PER MINUTE at speed 1 before scenario multipliers. */
  readonly rates: {
    readonly story: number;
    readonly comment: number;
    readonly attention: number;
    readonly join: number;
    readonly report: number;
  };
  /** Reading-depth sampling for attention aggregates (coarse buckets only). */
  readonly dwell: WeightedList<DwellBucket>;
  readonly replyDepth: WeightedList<ReplyDepthBucket>;
  readonly returns: WeightedList<ReturnVisitBucket>;
  readonly sourceOpenP: number;
  readonly contextOpenP: number;
  /** Stories touched per attention batch: [min, max]. */
  readonly itemsPerBatch: readonly [number, number];
  /** Probability a comment replies to an existing branch (vs a new root). */
  readonly replyP: number;
  /** Account backdate in days at provisioning (0 = brand-new account). */
  readonly accountAgeDays: number;
  /** Grants the platform `expert` role (expert-gated room posting). */
  readonly expertRole?: boolean;
}

const dw = (
  glance: number,
  short: number,
  medium: number,
  long: number,
  extended: number,
): WeightedList<DwellBucket> => [
  { value: 'glance', weight: glance },
  { value: 'short', weight: short },
  { value: 'medium', weight: medium },
  { value: 'long', weight: long },
  { value: 'extended', weight: extended },
];

const rd = (
  none: number,
  shallow: number,
  moderate: number,
  deep: number,
): WeightedList<ReplyDepthBucket> => [
  { value: 'none', weight: none },
  { value: 'shallow', weight: shallow },
  { value: 'moderate', weight: moderate },
  { value: 'deep', weight: deep },
];

const rv = (
  none: number,
  few: number,
  several: number,
  many: number,
): WeightedList<ReturnVisitBucket> => [
  { value: 'none', weight: none },
  { value: 'few', weight: few },
  { value: 'several', weight: several },
  { value: 'many', weight: many },
];

/** The behavioural catalogue. Rates are tuned so the default roster at speed 1
 *  produces a story every ~2–4 minutes, a comment every ~15–30 seconds, and a
 *  continuous trickle of attention — visible movement without saturating the
 *  real per-account limits (stories 10/h, contributions 10/min). */
export const PERSONA_ARCHETYPES: Readonly<Record<PersonaArchetypeId, PersonaArchetype>> = {
  author: {
    id: 'author',
    rates: { story: 0.05, comment: 0.08, attention: 0.25, join: 0.01, report: 0 },
    dwell: dw(1, 2, 4, 3, 1),
    replyDepth: rd(4, 3, 2, 1),
    returns: rv(6, 3, 1, 0),
    sourceOpenP: 0.5,
    contextOpenP: 0.4,
    itemsPerBatch: [1, 2],
    replyP: 0.5,
    accountAgeDays: 90,
  },
  local_correspondent: {
    id: 'local_correspondent',
    rates: { story: 0.04, comment: 0.1, attention: 0.25, join: 0.015, report: 0 },
    dwell: dw(1, 2, 4, 3, 1),
    replyDepth: rd(4, 3, 2, 1),
    returns: rv(5, 4, 1, 0),
    sourceOpenP: 0.35,
    contextOpenP: 0.5,
    itemsPerBatch: [1, 2],
    replyP: 0.6,
    accountAgeDays: 60,
  },
  expert_author: {
    id: 'expert_author',
    rates: { story: 0.03, comment: 0.09, attention: 0.2, join: 0.01, report: 0 },
    dwell: dw(0, 1, 3, 4, 3),
    replyDepth: rd(3, 3, 3, 1),
    returns: rv(4, 4, 2, 0),
    sourceOpenP: 0.8,
    contextOpenP: 0.7,
    itemsPerBatch: [1, 2],
    replyP: 0.55,
    accountAgeDays: 120,
    expertRole: true,
  },
  commenter: {
    id: 'commenter',
    rates: { story: 0.004, comment: 0.3, attention: 0.35, join: 0.02, report: 0 },
    dwell: dw(1, 3, 4, 2, 1),
    replyDepth: rd(2, 4, 3, 1),
    returns: rv(5, 4, 1, 0),
    sourceOpenP: 0.3,
    contextOpenP: 0.45,
    itemsPerBatch: [1, 3],
    replyP: 0.65,
    accountAgeDays: 45,
  },
  evidence_contributor: {
    id: 'evidence_contributor',
    rates: { story: 0.002, comment: 0.12, attention: 0.25, join: 0.015, report: 0 },
    dwell: dw(0, 1, 3, 4, 3),
    replyDepth: rd(3, 3, 3, 1),
    returns: rv(4, 4, 2, 0),
    sourceOpenP: 0.85,
    contextOpenP: 0.7,
    itemsPerBatch: [1, 2],
    replyP: 0.7,
    accountAgeDays: 75,
  },
  lurker: {
    id: 'lurker',
    rates: { story: 0, comment: 0, attention: 0.5, join: 0.01, report: 0 },
    dwell: dw(2, 4, 4, 2, 1),
    replyDepth: rd(8, 3, 1, 0),
    returns: rv(7, 3, 1, 0),
    sourceOpenP: 0.2,
    contextOpenP: 0.3,
    itemsPerBatch: [1, 3],
    replyP: 0,
    accountAgeDays: 30,
  },
  skimmer: {
    id: 'skimmer',
    rates: { story: 0, comment: 0.01, attention: 0.8, join: 0.005, report: 0 },
    dwell: dw(6, 4, 2, 0, 0),
    replyDepth: rd(9, 2, 0, 0),
    returns: rv(8, 2, 0, 0),
    sourceOpenP: 0.05,
    contextOpenP: 0.1,
    itemsPerBatch: [2, 4],
    replyP: 0.3,
    accountAgeDays: 20,
  },
  deep_reader: {
    id: 'deep_reader',
    rates: { story: 0, comment: 0.05, attention: 0.35, join: 0.015, report: 0 },
    dwell: dw(0, 1, 2, 4, 4),
    replyDepth: rd(3, 3, 3, 2),
    returns: rv(3, 4, 3, 1),
    sourceOpenP: 0.75,
    contextOpenP: 0.8,
    itemsPerBatch: [1, 2],
    replyP: 0.6,
    accountAgeDays: 50,
  },
  burst_returner: {
    id: 'burst_returner',
    rates: { story: 0, comment: 0.02, attention: 0.9, join: 0.005, report: 0 },
    dwell: dw(3, 4, 3, 1, 0),
    replyDepth: rd(6, 3, 1, 0),
    returns: rv(1, 3, 4, 3),
    sourceOpenP: 0.15,
    contextOpenP: 0.2,
    itemsPerBatch: [1, 1],
    replyP: 0.4,
    accountAgeDays: 15,
  },
  reporter: {
    id: 'reporter',
    rates: { story: 0, comment: 0.02, attention: 0.2, join: 0.01, report: 0.02 },
    dwell: dw(1, 3, 4, 2, 1),
    replyDepth: rd(6, 3, 1, 0),
    returns: rv(6, 3, 1, 0),
    sourceOpenP: 0.3,
    contextOpenP: 0.4,
    itemsPerBatch: [1, 2],
    replyP: 0.4,
    accountAgeDays: 40,
  },
  cluster_member: {
    id: 'cluster_member',
    // Idle in organic scenarios (never provisioned outside coordinated_burst);
    // that scenario multiplies these into a synchronized hammer on one focus
    // story. The report rate is set so that, with the burst multiplier, every
    // member files within the WS-J coordination window (300s) even at the
    // default speed of 1 — so all 12 distinct reporters cross the detector.
    rates: { story: 0, comment: 0.02, attention: 0.05, join: 0.005, report: 0.02 },
    dwell: dw(4, 4, 2, 0, 0),
    replyDepth: rd(7, 3, 0, 0),
    returns: rv(2, 4, 3, 1),
    sourceOpenP: 0.05,
    contextOpenP: 0.05,
    itemsPerBatch: [1, 1],
    replyP: 0.2,
    accountAgeDays: 0,
  },
  newcomer: {
    id: 'newcomer',
    rates: { story: 0.002, comment: 0.06, attention: 0.4, join: 0.05, report: 0 },
    dwell: dw(2, 4, 3, 1, 0),
    replyDepth: rd(6, 3, 1, 0),
    returns: rv(7, 3, 0, 0),
    sourceOpenP: 0.15,
    contextOpenP: 0.25,
    itemsPerBatch: [1, 2],
    replyP: 0.45,
    accountAgeDays: 0,
  },
};

export interface PersonaSpec {
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly archetype: PersonaArchetypeId;
  /** Topic-domain affinity keys (content.ts domains) biasing room/story picks. */
  readonly affinities: readonly string[];
}

const P = (
  n: number,
  handle: string,
  displayName: string,
  archetype: PersonaArchetypeId,
  affinities: readonly string[],
): PersonaSpec => ({ userId: SIM_USER_ID(n), handle, displayName, archetype, affinities });

/**
 * The fixed organic roster (provisioned at simulator start). Handles satisfy
 * the identity HANDLE_PATTERN and never collide with the demo-seed authors.
 */
export const BASE_ROSTER: readonly PersonaSpec[] = [
  P(1, 'wren_marsh', 'Wren Marsh', 'author', ['health', 'science']),
  P(2, 'felix_okafor', 'Felix Okafor', 'author', ['climate', 'elections']),
  P(3, 'june_calloway', 'June Calloway', 'author', ['elections', 'local']),
  P(4, 'omar_reyes', 'Omar Reyes', 'local_correspondent', ['local']),
  P(5, 'petra_lindqvist', 'Petra Lindqvist', 'local_correspondent', ['local', 'climate']),
  P(6, 'dr_amara_singh', 'Dr. Amara Singh', 'expert_author', ['science', 'health']),
  P(7, 'toby_grant', 'Toby Grant', 'commenter', ['climate', 'local']),
  P(8, 'mira_kovacs', 'Mira Kovacs', 'commenter', ['health', 'science']),
  P(9, 'des_whitfield', 'Des Whitfield', 'commenter', ['elections']),
  P(10, 'ines_moreau', 'Ines Moreau', 'commenter', ['local', 'health']),
  P(11, 'kip_nakamura', 'Kip Nakamura', 'commenter', ['science', 'climate']),
  P(12, 'sana_haddad', 'Sana Haddad', 'commenter', ['elections', 'climate']),
  P(13, 'ruth_adeyemi', 'Ruth Adeyemi', 'evidence_contributor', ['science', 'health']),
  P(14, 'gil_barros', 'Gil Barros', 'evidence_contributor', ['climate', 'elections']),
  P(15, 'nora_svensson', 'Nora Svensson', 'lurker', ['health']),
  P(16, 'ivan_petrov', 'Ivan Petrov', 'lurker', ['climate']),
  P(17, 'lucia_ferrara', 'Lucia Ferrara', 'lurker', ['local']),
  P(18, 'abe_koranteng', 'Abe Koranteng', 'lurker', ['elections']),
  P(19, 'demi_osei', 'Demi Osei', 'lurker', ['science']),
  P(20, 'flo_janssen', 'Flo Janssen', 'skimmer', ['local', 'climate']),
  P(21, 'ray_castillo', 'Ray Castillo', 'skimmer', ['elections', 'health']),
  P(22, 'bea_thornton', 'Bea Thornton', 'skimmer', ['science']),
  P(23, 'hana_dvorak', 'Hana Dvorak', 'deep_reader', ['science', 'health']),
  P(24, 'silas_mbeki', 'Silas Mbeki', 'deep_reader', ['climate']),
  P(25, 'greta_holm', 'Greta Holm', 'deep_reader', ['elections', 'local']),
  P(26, 'vic_marchetti', 'Vic Marchetti', 'burst_returner', ['climate']),
  P(27, 'ada_nwosu', 'Ada Nwosu', 'reporter', ['local', 'health']),
] as const;

/** The adversarial cluster (provisioned lazily by coordinated_burst so the
 *  accounts are genuinely FRESH when the burst begins). Sized to 12 so the
 *  synchronized reports deterministically cross the WS-J coordinated-report
 *  detector, which needs BOTH >= coordinationMinReports (default 10) AND
 *  >= coordinationMinDistinctReporters (default 8): each member files one
 *  non-idempotent report on the focus story, so 12 distinct reporters clear
 *  both thresholds with headroom. */
export const CLUSTER_ROSTER: readonly PersonaSpec[] = Array.from({ length: 12 }, (_, i) =>
  P(100 + i, `cluster_relay_${i + 1}`, `Relay ${i + 1}`, 'cluster_member', ['climate']),
);

/** Newcomer specs (provisioned incrementally by the influx scenario). */
export const NEWCOMER_CAP = 40;
const NEWCOMER_NAMES: readonly (readonly [string, string])[] = [
  ['arlo_fenn', 'Arlo Fenn'],
  ['bess_ito', 'Bess Ito'],
  ['cato_lund', 'Cato Lund'],
  ['dot_marlow', 'Dot Marlow'],
  ['edie_frank', 'Edie Frank'],
  ['fenwick_bao', 'Fenwick Bao'],
  ['gwen_asante', 'Gwen Asante'],
  ['hollis_wick', 'Hollis Wick'],
] as const;

export function newcomerSpec(index: number): PersonaSpec {
  const base = NEWCOMER_NAMES[index % NEWCOMER_NAMES.length];
  const generation = Math.floor(index / NEWCOMER_NAMES.length);
  const [handle, name] = base ?? (['arlo_fenn', 'Arlo Fenn'] as const);
  const suffix = generation === 0 ? '' : `_${generation + 1}`;
  const affinityPool = ['health', 'climate', 'elections', 'local', 'science'] as const;
  const affinity = affinityPool[index % affinityPool.length] ?? 'local';
  return P(
    200 + index,
    `${handle}${suffix}`,
    generation === 0 ? name : `${name} ${generation + 1}`,
    'newcomer',
    [affinity],
  );
}

export function archetypeOf(spec: PersonaSpec): PersonaArchetype {
  return PERSONA_ARCHETYPES[spec.archetype];
}
