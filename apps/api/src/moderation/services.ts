// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J moderation service container (the WS-F/G/I container pattern): a bundle
// of stores + ports + fail-closed config + ephemeral detectors, injectable at
// boot.  Routes read the module singleton via `getModerationServices()`; the
// production boot swaps Postgres adapters + real ports in by assignment;
// tests build an in-memory container and `setModerationServices(...)`.
import type { PwattConfigStore } from '../events/stores.js';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import {
  DEFAULT_MODERATION_CONFIG,
  loadModerationConfig,
  type ModerationRuntimeConfig,
} from './config.js';
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
  InMemoryAccountBlockStore,
  InMemoryAccountMuteStore,
  InMemoryCoordinatedReportIncidentStore,
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
  blocks: AccountBlockStore;
  mutes: AccountMuteStore;
  appeals: ModerationAppealStore;
  notices: ModerationNoticeStore;
  reviewerStatus: ReviewerStatusStore;
  incidents: CoordinatedReportIncidentStore;
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
  config: () => ModerationRuntimeConfig;
  reloadConfig: () => Promise<ModerationRuntimeConfig>;
  metrics: ModerationMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  trackBackground: (work: Promise<unknown>) => void;
  settle: () => Promise<void>;
  now: () => number;
}

export interface InMemoryModerationOptions {
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

  const services: ModerationServices = {
    cases: new InMemoryModerationCaseStore(now),
    reports: new InMemoryModerationReportStore(now),
    actions: new InMemoryModerationActionStore(now),
    audit: new InMemoryModerationAuditStore(now),
    blocks: new InMemoryAccountBlockStore(now),
    mutes: new InMemoryAccountMuteStore(now),
    appeals: new InMemoryModerationAppealStore(now),
    notices: new InMemoryModerationNoticeStore(now),
    reviewerStatus: new InMemoryReviewerStatusStore(),
    incidents: new InMemoryCoordinatedReportIncidentStore(now),
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
