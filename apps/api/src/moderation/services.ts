// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J moderation service container (the WS-F/G/I container pattern): a bundle
// of stores + ports + fail-closed config + ephemeral detectors, injectable at
// boot.  Routes read the module singleton via `getModerationServices()`; the
// production boot swaps Postgres adapters + real ports in by assignment;
// tests build an in-memory container and `setModerationServices(...)`.
import { createHash } from 'node:crypto';
import type { ModerationQueue } from '@licio/shared';
import type { PwattConfigStore } from '../events/stores.js';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import type { InMemoryRollback } from '../lib/in-memory-rollback.js';
import { appendAudit } from './audit.js';
import type { AuditChainDeps } from './audit-chain.js';
import {
  DEFAULT_MODERATION_CONFIG,
  loadModerationConfig,
  type ModerationRuntimeConfig,
} from './config.js';
import type { UrlVerdict } from './malware-fetch.js';
import {
  defaultAlertPort,
  defaultContentPort,
  defaultEventPort,
  defaultInvariantPort,
  defaultUserPort,
  type ModerationAlertPort,
  type ModerationContentPort,
  type ModerationEventPort,
  type ModerationInvariantPort,
  type ModerationUserPort,
} from './ports.js';
import {
  HeuristicPolicyRiskClassifier,
  LocalBlocklistReputationProvider,
  type PolicyRiskClassifier,
  RecentSubmissionTracker,
  type UrlReputationProvider,
} from './prechecks.js';
import {
  type AccountBlockStore,
  type AccountMuteStore,
  type CoordinatedReportIncidentStore,
  type EvidenceDecisionStore,
  InMemoryAccountBlockStore,
  InMemoryAccountMuteStore,
  InMemoryCoordinatedReportIncidentStore,
  InMemoryEvidenceDecisionStore,
  InMemoryModerationActionStore,
  InMemoryModerationAppealStore,
  InMemoryModerationAuditStore,
  InMemoryModerationCaseStore,
  InMemoryModerationNoticeStore,
  InMemoryModerationReportStore,
  InMemoryReviewerStatusStore,
  type ModerationActionStore,
  type ModerationAppealStore,
  type ModerationAuditStore,
  type ModerationCaseStore,
  type ModerationNoticeStore,
  type ModerationReportStore,
  type ReviewerStatusStore,
} from './stores.js';
import { InMemoryModerationTransactor, type ModerationTransactor } from './transactor.js';

/** In-process counters (no PII; observability only, SPEC §18.2). */
export class ModerationMetrics {
  readonly #counts = new Map<string, number>();
  increment(name: string, by = 1): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + by);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counts);
  }
  clear(): void {
    this.#counts.clear();
  }
}

export interface ModerationServices {
  cases: ModerationCaseStore;
  reports: ModerationReportStore;
  actions: ModerationActionStore;
  audit: ModerationAuditStore;
  /**
   * Run a state change and its audit record as ONE unit (WS-J.2.3, `transactor.ts`).
   *
   * Replaced at production boot by `DrizzleModerationTransactor`, which arrives from the
   * same factory as the Postgres stores so the two cannot be half-wired.  Until then the
   * in-memory twin serialises units and rolls back on a throw, so both sides answer the
   * same question about what a failed unit leaves behind.
   */
  transactor: ModerationTransactor;
  /**
   * The WS-S §21.4 demotion a moderation unit performs, wired at boot.
   *
   * Held on the services rather than imported, so moderation never reaches into
   * the private-rooms domain to construct its store — the same rule `content`
   * follows. Absent ⇒ the unit reports "nothing matched", which is the
   * fail-closed answer: a staff delist that cannot reach the store must not be
   * recorded as one that did.
   */
  delistListedRoom?: (roomServerId: string) => Promise<boolean>;
  /**
   * Is this room's §21 directory record publicly LISTED?
   *
   * Read-only, and the case review's only question about the private plane: it
   * decides whether §11.4's delist is offered on a room case at all. Injected
   * for the same reason `delistListedRoom` is — moderation does not reach into
   * the private-rooms domain. Absent ⇒ never offered, which is fail-closed.
   */
  isPubliclyListedRoom?: (roomServerId: string) => Promise<boolean>;
  /**
   * Add a store from another domain to the in-memory unit's rollback boundary.
   *
   * A method rather than a constructor option because the participant may not
   * exist yet: the private-room stub store is built after these services in both
   * composition roots. The list is read per run, so registering later is
   * enough — and getting it wrong now shows up as a demotion surviving a failed
   * audit in dev and test, which is the failure the unit exists to prevent.
   */
  registerRollback(store: InMemoryRollback): void;
  /** The audit trail's tamper-evidence key + identifier ref (WS-J.2.5, migration 0118).
   *
   *  Present by DEFAULT — in dev and test as well as production — because a chain that
   *  only the production wiring turns on is a chain no test exercises, and the first time
   *  anyone runs the verifier would be the first time the code has ever run.  Production
   *  derives the key from the identity master secret; the in-memory factory derives a
   *  local one, so the SHAPE of every trail is the same everywhere. */
  auditChain: AuditChainDeps;
  blocks: AccountBlockStore;
  mutes: AccountMuteStore;
  appeals: ModerationAppealStore;
  notices: ModerationNoticeStore;
  reviewerStatus: ReviewerStatusStore;
  incidents: CoordinatedReportIncidentStore;
  evidenceDecisions: EvidenceDecisionStore;
  /** Ephemeral per-account recent-submission window (flood/velocity). */
  submissions: RecentSubmissionTracker;
  content: ModerationContentPort;
  users: ModerationUserPort;
  invariants: ModerationInvariantPort;
  events: ModerationEventPort;
  alerts: ModerationAlertPort;
  urlReputation: UrlReputationProvider;
  policyRisk: PolicyRiskClassifier;
  configStore: PwattConfigStore;
  /** WS-J #18: the moderation queues a reviewer may access — used to filter
   *  auto-assignment to ELIGIBLE reviewers.  Absent ⇒ no filter (every available
   *  reviewer is eligible, the test/default posture); wired at boot to the WS-D
   *  steward roles. */
  reviewerQueues?: (userId: string) => Promise<readonly ModerationQueue[]>;
  /** WS-J.2.6b redirect-chain malware verdict for the reviewer link-OPENING
   *  path (never the submission path — §18.3 SSRF posture).  Wired at boot over
   *  the WS-F SSRF-hardened fetcher + the live blocklists; absent ⇒ the console
   *  route reports `unavailable` (fail toward flagging, never trusting). */
  urlVerdict?: (url: string) => Promise<UrlVerdict>;
  config: () => ModerationRuntimeConfig;
  reloadConfig: () => Promise<ModerationRuntimeConfig>;
  metrics: ModerationMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  trackBackground: (work: Promise<unknown>) => void;
  settle: () => Promise<void>;
  now: () => number;
}

export interface InMemoryModerationOptions {
  /** Override the audit chain's MAC key (production passes the derived one). */
  auditChainKey?: string;
  /**
   * Stores from OTHER domains that a unit may write, so the in-memory rollback
   * boundary covers them too.
   *
   * The private-room stub store is one: §21.4's staff demotion runs inside the
   * unit, and a unit that restores only the moderation stores would leave a
   * demotion standing when its audit throws. Injected rather than imported —
   * moderation does not construct another domain's store, here or in the
   * Postgres transactor.
   */
  extraRollbacks?: readonly InMemoryRollback[];
  config?: Partial<ModerationRuntimeConfig>;
  content?: ModerationContentPort;
  users?: ModerationUserPort;
  invariants?: ModerationInvariantPort;
  events?: ModerationEventPort;
  alerts?: ModerationAlertPort;
  urlReputation?: UrlReputationProvider;
  policyRisk?: PolicyRiskClassifier;
  configStore?: PwattConfigStore;
  log?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

export function createInMemoryModerationServices(
  options: InMemoryModerationOptions = {},
): ModerationServices {
  const now = options.now ?? Date.now;
  const configStore = options.configStore ?? new InMemoryPwattConfigStore();
  let config: ModerationRuntimeConfig = { ...DEFAULT_MODERATION_CONFIG, ...options.config };
  const pending: Array<Promise<unknown>> = [];
  const metrics = new ModerationMetrics();
  const log = options.log ?? ((): void => {});

  const auditStore = new InMemoryModerationAuditStore(now);
  const caseStore = new InMemoryModerationCaseStore(now);
  const actionStore = new InMemoryModerationActionStore(now);
  const noticeStore = new InMemoryModerationNoticeStore(now);
  const appealStore = new InMemoryModerationAppealStore(now);
  const incidentStore = new InMemoryCoordinatedReportIncidentStore(now);
  /** Participants registered after construction — see `registerRollback`. */
  const extraRollbacks: InMemoryRollback[] = [];
  const services: ModerationServices = {
    registerRollback: (store) => {
      if (!extraRollbacks.includes(store)) extraRollbacks.push(store);
    },
    cases: caseStore,
    reports: new InMemoryModerationReportStore(now),
    actions: actionStore,
    audit: auditStore,
    // The unit of work.  `audit` reads `services.auditChain` at CALL time rather than
    // capturing it, so a boot that rewires the chain key does not leave the transactor
    // signing with the dev one.
    transactor: new InMemoryModerationTransactor(
      {
        cases: caseStore,
        actions: actionStore,
        notices: noticeStore,
        appeals: appealStore,
        incidents: incidentStore,
        // Read at CALL time: the production boot swaps in the Drizzle config
        // store after this object is built, and a captured reference would keep
        // writing where nothing else reads.
        get config() {
          return services.configStore;
        },
        // A no-op: the in-memory transactor already runs units one at a time, which is
        // the property the Postgres advisory lock buys.
        lockRevertScope: async () => {},
        // The in-memory unit shares the services' own port: there is no second handle to
        // bind, and a fold over Maps has no partial commit to protect against.
        content: {
          applyContentState: (...args) => services.content.applyContentState(...args),
          applyAccountState: (...args) => services.content.applyAccountState(...args),
        },
        // Same reasoning as `content`: the in-memory unit shares the process's own
        // stub store, and a fold over Maps has no partial commit to protect
        // against — but the SHAPE must exist on both sides, or the atomicity the
        // Postgres unit provides would be a property only production has.
        delistListedRoom: async (roomServerId) =>
          (await services.delistListedRoom?.(roomServerId)) ?? false,
        audit: (input) => appendAudit(services.auditChain, input),
      },
      // The private-room stub store is in the ROLLBACK LIST too, or the in-memory
      // unit would restore the moderation side of a failed staff delist and
      // leave the demotion standing — the failure the unit exists to prevent,
      // reproduced only where nobody looks for it. It is supplied by the boot
      // wiring alongside `delistListedRoom`, so moderation still never
      // constructs another domain's store.
      // Read at RUN time: a participant from another domain (the private-room
      // stub store) is built after these services, so a list fixed here would
      // silently exclude it — which is how the guarantee ends up holding in one
      // composition root and not another.
      () => [
        caseStore,
        actionStore,
        noticeStore,
        appealStore,
        incidentStore,
        auditStore,
        ...(services.configStore instanceof InMemoryPwattConfigStore ? [services.configStore] : []),
        ...(options.extraRollbacks ?? []),
        ...extraRollbacks,
      ],
    ),
    auditChain: {
      store: auditStore,
      // A LOCAL key, overridden at production boot from the identity master secret.  It
      // exists so the chain runs everywhere: a tamper-evidence path that only production
      // exercises is one whose first real execution is in production.
      key: options.auditChainKey ?? 'licio-dev-moderation-audit-chain',
      refOf: (id) => createHash('sha256').update(`moderation-audit-ref:${id}`).digest('hex'),
    },
    blocks: new InMemoryAccountBlockStore(now),
    mutes: new InMemoryAccountMuteStore(now),
    appeals: appealStore,
    notices: noticeStore,
    reviewerStatus: new InMemoryReviewerStatusStore(),
    incidents: incidentStore,
    evidenceDecisions: new InMemoryEvidenceDecisionStore(now),
    submissions: new RecentSubmissionTracker(),
    content: options.content ?? defaultContentPort,
    users: options.users ?? defaultUserPort,
    invariants: options.invariants ?? defaultInvariantPort,
    events: options.events ?? defaultEventPort,
    alerts: options.alerts ?? defaultAlertPort,
    urlReputation:
      options.urlReputation ??
      new LocalBlocklistReputationProvider(() => new Set(config.malwareDomains)),
    policyRisk: options.policyRisk ?? new HeuristicPolicyRiskClassifier(),
    configStore,
    config: () => config,
    reloadConfig: async () => {
      config = await loadModerationConfig(configStore, (key, problem) =>
        log('moderation.config_invalid', { key, problem }),
      );
      return config;
    },
    metrics,
    log,
    trackBackground: (work) => {
      pending.push(
        work.catch((error) => {
          log('moderation.background_error', { error: String(error) });
        }),
      );
    },
    settle: async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
      }
    },
    now,
  };
  return services;
}

let singleton: ModerationServices | null = null;

export function setModerationServices(services: ModerationServices): void {
  singleton = services;
}

export function getModerationServices(): ModerationServices {
  if (!singleton) singleton = createInMemoryModerationServices();
  return singleton;
}

export function resetModerationServicesForTests(): void {
  singleton = null;
}
