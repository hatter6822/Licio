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
  const services: ModerationServices = {
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
        audit: (input) => appendAudit(services.auditChain, input),
      },
      [caseStore, actionStore, noticeStore, appealStore, incidentStore, auditStore],
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
