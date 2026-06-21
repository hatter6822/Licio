// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The deterministic discrete-event network simulator (OFFLINE_SPEC §32.3, WS-R.18.3a).
// A virtual clock processes timed `contacts` between `SimNode`s; each contact runs the
// REAL lane scheduler (`scheduleTransfer` — true C0 reservation + DRR) to decide what
// moves under the contact's byte budget, and the REAL dependency closure (`requires`)
// to decide acceptance vs. quarantine — no simulator-only shortcut through scheduling
// or validation.  A seeded PRNG drives the link model (loss / duplication / partition)
// and node behaviors are pluggable strategies (honest / withholding / flooding /
// equivocating).  `run(seed, scenario)` is fully reproducible: the same pair yields the
// identical trace and outcome.  It samples the §32.3 metrics and stores no IP/attention.

import { defaultLane, type LcapPriority } from '../../priority.js';
import { scheduleTransfer } from '../../scheduler/index.js';
import type { ScheduledCandidate } from '../../scheduler/types.js';
import type { TransportId } from '../../transport/index.js';
import { makePrng } from './prng.js';

/** A content object in the simulated world. */
export interface SimObject {
  readonly cid: string;
  readonly priority: LcapPriority;
  readonly bytes: number;
  /** CIDs that MUST be held before this object can be accepted (else quarantine). */
  readonly requires?: readonly string[];
  /** Objects sharing a fork group are conflicting variants (equivocation); ≥2 held ⇒ fork. */
  readonly forkGroup?: string;
}

/** A node behavior strategy (the §32.3 adversary plug-in points). */
export type NodeBehavior = 'honest' | 'withholding' | 'flooding' | 'equivocating';

export interface SimNodeSpec {
  readonly id: string;
  /** CIDs this node holds at the start. */
  readonly holds: readonly string[];
  readonly behavior?: NodeBehavior;
}

/** A scheduled meeting of two nodes (a bounded transfer window). */
export interface ContactSpec {
  readonly atMs: number;
  readonly a: string;
  readonly b: string;
  /** Which transport carries this contact (for the §32.5 transport-independence test). */
  readonly transport?: TransportId;
}

export interface RunOptions {
  /** Only contacts on these transports happen (default: ALL). */
  readonly enabledTransports?: readonly TransportId[];
}

export interface LinkModel {
  /** Per-object delivery-loss probability. */
  readonly lossProb?: number;
  /** Per-object duplicate-delivery probability (replay tolerance). */
  readonly dupProb?: number;
  /** Probability the whole contact is partitioned (no transfer). */
  readonly partitionProb?: number;
}

export interface SimScenario {
  readonly objects: readonly SimObject[];
  readonly nodes: readonly SimNodeSpec[];
  readonly contacts: readonly ContactSpec[];
  /** Bytes one direction of a contact may transfer (the scheduler's budget). */
  readonly contactBudgetBytes: number;
  readonly link?: LinkModel;
}

export interface ArrivalEvent {
  readonly atMs: number;
  readonly node: string;
  readonly cid: string;
  readonly priority: LcapPriority;
  readonly accepted: boolean; // false ⇒ quarantined (missing requires)
}

export interface SimResult {
  /** Every arrival (accepted or quarantined), in deterministic order. */
  readonly arrivals: readonly ArrivalEvent[];
  /** Final accepted-CID set per node. */
  readonly held: Readonly<Record<string, readonly string[]>>;
  /** Final quarantined-CID set per node (missing-dependency). */
  readonly quarantined: Readonly<Record<string, readonly string[]>>;
  /** Nodes (with contact index) at which a fork group was detected. */
  readonly forksDetected: ReadonlyArray<{ node: string; forkGroup: string; contactIndex: number }>;
  /** A stable digest of the run for byte-reproducibility assertions. */
  readonly traceDigest: string;
}

interface NodeState {
  readonly spec: SimNodeSpec;
  readonly held: Set<string>;
  readonly quarantine: Set<string>;
  readonly forkSeen: Map<string, Set<string>>; // forkGroup -> cids seen
}

function toCandidate(
  object: SimObject,
  receiverHeld: ReadonlySet<string>,
  bypassClosure: boolean,
): ScheduledCandidate {
  // The scheduler places a candidate only once its `requires` are placed in THIS
  // transfer.  A prerequisite the receiver already holds is satisfied, so it is
  // stripped here — the offerer need not re-send what the receiver has (§17.5).  A
  // FLOODING adversary bypasses the closure entirely (it dumps orphans), so its
  // candidates carry no `requires`; the receiver's import then quarantines the orphan.
  return {
    cid: object.cid,
    lane: defaultLane(object.priority),
    priority: object.priority,
    bytes: object.bytes,
    requires: bypassClosure ? [] : (object.requires ?? []).filter((dep) => !receiverHeld.has(dep)),
    reason: 'want',
  };
}

/** What an offerer with `behavior` is willing to share of the receiver's wants. */
function offered(behavior: NodeBehavior, wanted: readonly SimObject[]): readonly SimObject[] {
  // A withholding relay shares nothing; honest/flooding/equivocating all offer their
  // holdings (flooding's extra duplicates + equivocation's conflicting variants are a
  // property of the objects/link, surfaced as fork evidence — never suppressed).
  return behavior === 'withholding' ? [] : wanted;
}

/** Record an arrival into `receiver`, accepting iff the closure `requires` is met. */
function deliver(
  receiver: NodeState,
  object: SimObject,
  atMs: number,
  arrivals: ArrivalEvent[],
  contactIndex: number,
  forks: Array<{ node: string; forkGroup: string; contactIndex: number }>,
): void {
  const requiresMet = (object.requires ?? []).every((dep) => receiver.held.has(dep));
  arrivals.push({
    atMs,
    node: receiver.spec.id,
    cid: object.cid,
    priority: object.priority,
    accepted: requiresMet,
  });
  if (requiresMet) {
    receiver.held.add(object.cid);
    receiver.quarantine.delete(object.cid);
  } else {
    receiver.quarantine.add(object.cid);
  }
  if (object.forkGroup !== undefined) {
    const seen = receiver.forkSeen.get(object.forkGroup) ?? new Set<string>();
    seen.add(object.cid);
    receiver.forkSeen.set(object.forkGroup, seen);
    if (
      seen.size >= 2 &&
      !forks.some((f) => f.node === receiver.spec.id && f.forkGroup === object.forkGroup)
    ) {
      forks.push({ node: receiver.spec.id, forkGroup: object.forkGroup, contactIndex });
    }
  }
}

/** Run one direction of a contact: offerer → receiver, under the scheduler + link model. */
function transferDirection(
  offerer: NodeState,
  receiver: NodeState,
  byCid: ReadonlyMap<string, SimObject>,
  budgetBytes: number,
  atMs: number,
  link: Required<LinkModel>,
  prng: ReturnType<typeof makePrng>,
  arrivals: ArrivalEvent[],
  contactIndex: number,
  forks: Array<{ node: string; forkGroup: string; contactIndex: number }>,
): void {
  const wanted: SimObject[] = [];
  for (const cid of offerer.held) {
    if (receiver.held.has(cid)) continue;
    const object = byCid.get(cid);
    if (object) wanted.push(object);
  }
  const toOffer = offered(offerer.spec.behavior ?? 'honest', wanted);
  if (toOffer.length === 0) return;

  const flooding = offerer.spec.behavior === 'flooding';
  // The REAL scheduler decides the transfer order + what fits the budget (C0 first).
  const schedule = scheduleTransfer(
    toOffer.map((object) => toCandidate(object, receiver.held, flooding)),
    { budgetBytes, nowMs: atMs },
  );
  for (const entry of schedule.packTable) {
    const object = byCid.get(entry.cid);
    if (!object) continue;
    if (prng.bool(link.lossProb)) continue; // lost in transit
    deliver(receiver, object, atMs, arrivals, contactIndex, forks);
    // A flooding peer (or a lossy-dup link) re-delivers; a Set makes this idempotent,
    // proving duplicate/replay delivery never corrupts the accepted set.
    if (flooding || prng.bool(link.dupProb)) {
      deliver(receiver, object, atMs, arrivals, contactIndex, forks);
    }
  }
}

/** A stable digest of the arrival trace (order-sensitive) for reproducibility checks. */
function digest(arrivals: readonly ArrivalEvent[]): string {
  let h = 2166136261 >>> 0; // FNV-1a over the trace string
  const text = arrivals.map((a) => `${a.atMs}|${a.node}|${a.cid}|${a.accepted ? 1 : 0}`).join(';');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Run the scenario deterministically from `seed`.  Contacts are processed in
 * (atMs, contactIndex) order; each runs both directions through the real scheduler +
 * closure; the seeded link model perturbs delivery.  Reproducible: equal `(seed,
 * scenario)` ⇒ equal `arrivals`/`held`/`traceDigest`.
 */
export function run(seed: number, scenario: SimScenario, options: RunOptions = {}): SimResult {
  const prng = makePrng(seed);
  const enabled = options.enabledTransports ? new Set(options.enabledTransports) : null;
  const link: Required<LinkModel> = {
    lossProb: scenario.link?.lossProb ?? 0,
    dupProb: scenario.link?.dupProb ?? 0,
    partitionProb: scenario.link?.partitionProb ?? 0,
  };
  const byCid = new Map(scenario.objects.map((o) => [o.cid, o] as const));
  const nodes = new Map<string, NodeState>(
    scenario.nodes.map((spec) => [
      spec.id,
      { spec, held: new Set(spec.holds), quarantine: new Set<string>(), forkSeen: new Map() },
    ]),
  );

  const arrivals: ArrivalEvent[] = [];
  const forks: Array<{ node: string; forkGroup: string; contactIndex: number }> = [];

  const ordered = [...scenario.contacts]
    .map((contact, index) => ({ contact, index }))
    .sort((x, y) => x.contact.atMs - y.contact.atMs || x.index - y.index);

  for (const { contact, index } of ordered) {
    // A contact on a disabled transport simply does not happen (the §32.5 test toggles
    // transport subsets; an untagged contact is always enabled).
    if (enabled && contact.transport !== undefined && !enabled.has(contact.transport)) continue;
    const a = nodes.get(contact.a);
    const b = nodes.get(contact.b);
    if (!a || !b) continue;
    if (prng.bool(link.partitionProb)) continue; // contact partitioned away
    transferDirection(
      a,
      b,
      byCid,
      scenario.contactBudgetBytes,
      contact.atMs,
      link,
      prng,
      arrivals,
      index,
      forks,
    );
    transferDirection(
      b,
      a,
      byCid,
      scenario.contactBudgetBytes,
      contact.atMs,
      link,
      prng,
      arrivals,
      index,
      forks,
    );
  }

  const held: Record<string, readonly string[]> = {};
  const quarantined: Record<string, readonly string[]> = {};
  for (const [id, state] of nodes) {
    held[id] = [...state.held].sort();
    quarantined[id] = [...state.quarantine].filter((cid) => !state.held.has(cid)).sort();
  }

  return { arrivals, held, quarantined, forksDetected: forks, traceDigest: digest(arrivals) };
}
