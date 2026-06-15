// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J integration ports.  Moderation acts on content/accounts owned by other
// workstreams (WS-F/G content, WS-D accounts, WS-H invariant signals, WS-E
// events) and pages on-call (WS-O).  Rather than import those services directly
// (cycles + tight coupling), WS-J depends on these narrow PORTS, wired to the
// real services at boot (index.ts / services.ts) and to lightweight stubs in
// tests.  Defaults are safe no-ops / "unavailable" so the console is fully
// usable before the invariant services ship (WS-J.2.2c graceful degradation).
import type { ContributionPublic, InvariantSignalsPanel, ReportContentKind } from '@licio/shared';

/** Resolution of a moderation target (subject user, existence, kind). */
export interface TargetResolution {
  exists: boolean;
  /** The user the target belongs to (the action subject); null for room/unknown. */
  subjectUserId: string | null;
  contentKind: ReportContentKind | null;
}

/** Visibility states a content action drives (consumed by the ranking seam). */
export type ContentVisibilityState = 'visible' | 'hidden' | 'removed';
/** Account states an account action drives. */
export type AccountActionState = 'active' | 'restricted' | 'suspended' | 'banned';

export interface ContentSnapshot {
  originalBody: string;
  currentBody: string;
  originalAt: string;
  currentAt: string;
  editedAfterReport: boolean;
}

/** The content/account port — the WS-F/G/E/D write+read seam for moderation. */
export interface ModerationContentPort {
  resolveTarget(targetType: string, targetId: string): Promise<TargetResolution>;
  /** Apply a content visibility change.  MUST be reflected to the ranking
   *  distribution side (WS-E item safety state / WS-F hidden state / WS-G
   *  contribution moderation_state) so removed/hidden content leaves feeds. */
  applyContentState(
    targetId: string,
    contentKind: ReportContentKind | null,
    state: ContentVisibilityState,
    caseId: string | null,
    actorRef: string,
  ): Promise<void>;
  /** Apply an account state change (restrict/suspend/ban/lift). */
  applyAccountState(
    userId: string,
    state: AccountActionState,
    durationDays: number | null,
  ): Promise<void>;
  /** Report-time vs current snapshot for the side-by-side diff (WS-J.2.2d). */
  contentSnapshot(targetId: string, reportTimeIso: string): Promise<ContentSnapshot | null>;
  /** Thread context centered on the reported item (WS-J.2.2a). */
  threadContext(
    targetId: string,
    contentKind: ReportContentKind | null,
    requesterUserId: string,
  ): Promise<{ items: ContributionPublic[]; reportedContributionId: string | null }>;
}

export interface ResolvedUser {
  handle: string | null;
  accountAgeDays: number | null;
  contributionCount: number;
  contributionTypes: Record<string, number>;
  roomsActiveIn: number;
}

/** The account-metadata port (WS-D / WS-E-WS-G internal stats). */
export interface ModerationUserPort {
  resolve(userId: string): Promise<ResolvedUser | null>;
  resolveMany(userIds: readonly string[]): Promise<Map<string, ResolvedUser>>;
}

/** The invariant decision-support port (WS-H), read-only and never a verdict. */
export interface ModerationInvariantPort {
  signalsFor(
    targetType: string,
    targetId: string,
    subjectUserId: string | null,
    coordinationDetail: boolean,
  ): Promise<InvariantSignalsPanel>;
}

/** The WS-E event-emission port (moderation.case.created etc.). */
export interface ModerationEventPort {
  caseCreated(input: {
    caseId: string;
    targetType: string;
    targetId: string;
    reporterId: string | null;
    reasonCode: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    source: 'user_report' | 'automated';
    nowIso: string;
  }): Promise<void>;
}

/** On-call alerting port (WS-O.2) — emergency reports / critical flags. */
export interface ModerationAlertPort {
  pageOnCall(input: {
    kind: 'emergency_report' | 'critical_flag' | 'coordinated_report';
    targetType: string;
    targetId: string;
    reasonCode: string | null;
    severity: string;
  }): void;
}

// ---------------------------------------------------------------------------
// Safe defaults.
// ---------------------------------------------------------------------------

export const UNAVAILABLE_SIGNAL = { available: false, state: null, detail: null } as const;

export const SIGNALS_DISCLAIMER = 'These signals inform review but do not determine outcomes.';

/** Default invariant port: all signals "unavailable" (WS-H not yet wired). */
export const defaultInvariantPort: ModerationInvariantPort = {
  async signalsFor(): Promise<InvariantSignalsPanel> {
    return {
      mfci: { ...UNAVAILABLE_SIGNAL },
      scoi: { ...UNAVAILABLE_SIGNAL },
      phi: { ...UNAVAILABLE_SIGNAL },
      hodge: { ...UNAVAILABLE_SIGNAL },
      disclaimer: SIGNALS_DISCLAIMER,
    };
  },
};

/** Default content port: resolves account targets to themselves; everything
 *  else is a no-op (the production port wires WS-F/G/E). */
export const defaultContentPort: ModerationContentPort = {
  async resolveTarget(targetType, targetId): Promise<TargetResolution> {
    if (targetType === 'account')
      return { exists: true, subjectUserId: targetId, contentKind: null };
    return { exists: true, subjectUserId: null, contentKind: null };
  },
  async applyContentState(): Promise<void> {},
  async applyAccountState(): Promise<void> {},
  async contentSnapshot(): Promise<ContentSnapshot | null> {
    return null;
  },
  async threadContext(): Promise<{
    items: ContributionPublic[];
    reportedContributionId: string | null;
  }> {
    return { items: [], reportedContributionId: null };
  },
};

/** Default user port: nothing resolvable (history shows "no prior history"). */
export const defaultUserPort: ModerationUserPort = {
  async resolve(): Promise<ResolvedUser | null> {
    return null;
  },
  async resolveMany(): Promise<Map<string, ResolvedUser>> {
    return new Map();
  },
};

/** Default event port: no-op (events wired at boot when the pipeline exists). */
export const defaultEventPort: ModerationEventPort = {
  async caseCreated(): Promise<void> {},
};

/** Default alert port: no-op (the production sink pages; tests can record). */
export const defaultAlertPort: ModerationAlertPort = {
  pageOnCall(): void {},
};
