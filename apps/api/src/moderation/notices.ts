// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.3d user notices: the durable "statement of reasons" + appeal-outcome
// inbox the user reads (the in-app notification centre).  Every SIGNIFICANT
// action emits a readable notice with the reason code and, where appealable, the
// appeal path — no silent sanctions (cross-cutting invariant 2).  The inbox is
// the authoritative delivery channel; push is a best-effort enhancement layered
// on top.
import type {
  AppealStatus,
  ModerationNoticeListResponse,
  ModerationNoticeView,
  ModerationReasonCode,
} from '@licio/shared';
import type { ModerationServices } from './services.js';
import type { ModerationNoticeRecord, ModerationNoticeStore } from './stores.js';

/** Human-readable phrasing for an action's statement of reasons. */
const ACTION_PHRASING: Readonly<Record<string, { title: string; verb: string }>> = {
  warn: { title: 'You received a warning', verb: 'A warning was issued regarding your content' },
  hide: { title: 'Your content was hidden', verb: 'Your content was hidden from public view' },
  remove: { title: 'Your content was removed', verb: 'Your content was removed' },
  restrict: {
    title: 'Your account was restricted',
    verb: 'Your account was temporarily restricted',
  },
  shadow: {
    title: 'Your content reach was reduced',
    verb: 'The distribution of your content was reduced',
  },
  suspend: { title: 'Your account was suspended', verb: 'Your account was temporarily suspended' },
  ban: { title: 'Your account was banned', verb: 'Your account was permanently banned' },
  emergency_restriction: {
    title: 'Your account was restricted (emergency review)',
    verb: 'Your account was restricted pending an emergency safety review',
  },
};

const SUPPORT_LINE =
  'If you believe this was a mistake, you can reach the safety team from the support contact on any screen.';

/** Build the statement-of-reasons body for an action notice. */
export function statementOfReasons(
  action: string,
  reasonCode: string | null,
  appealable: boolean,
  appealAvailableNote: string | null,
): string {
  const phrasing = ACTION_PHRASING[action] ?? {
    title: 'A moderation action was taken',
    verb: 'A moderation action was taken on your account',
  };
  const reasonLine = reasonCode ? ` This action references policy reason ${reasonCode}.` : '';
  const appealLine = appealable
    ? ' You may appeal this decision from this notice.'
    : appealAvailableNote
      ? ` ${appealAvailableNote}`
      : ' This action is not appealable.';
  return `${phrasing.verb}.${reasonLine}${appealLine} ${SUPPORT_LINE}`;
}

export interface ActionNoticeInput {
  userId: string;
  actionId: string;
  action: string;
  reasonCode: string | null;
  appealable: boolean;
  appealAvailableNote?: string | null;
}

/**
 * Create + persist the statement-of-reasons notice for a significant action.
 *
 * `store` defaults to the services' own, and is overridden with a unit's notice store by
 * callers that write the notice INSIDE their unit — a rolled-back sanction must not leave
 * the member holding a statement of reasons for something that did not happen.
 */
export async function createActionNotice(
  services: ModerationServices,
  input: ActionNoticeInput,
  store: ModerationNoticeStore = services.notices,
): Promise<ModerationNoticeRecord> {
  const phrasing = ACTION_PHRASING[input.action] ?? {
    title: 'A moderation action was taken',
    verb: '',
  };
  const notice = await store.insert({
    userId: input.userId,
    kind: 'action',
    actionId: input.actionId,
    title: phrasing.title,
    body: statementOfReasons(
      input.action,
      input.reasonCode,
      input.appealable,
      input.appealAvailableNote ?? null,
    ),
    reasonCode: input.reasonCode,
    appealable: input.appealable,
    appealStatus: null,
    readAt: null,
  });
  services.metrics.increment('notices.action');
  return notice;
}

const OUTCOME_TITLE: Readonly<Record<Exclude<AppealStatus, 'pending'>, string>> = {
  overturned: 'Your appeal was approved',
  upheld: 'Your appeal was reviewed',
  modified: 'Your appeal led to a reduced action',
};

export interface AppealOutcomeNoticeInput {
  userId: string;
  actionId: string;
  appealStatus: Exclude<AppealStatus, 'pending'>;
  reasonCode: string | null;
  explanation: string;
}

/** Create + persist the appeal-outcome notice (WS-J.1.3d). */
export async function createAppealOutcomeNotice(
  services: ModerationServices,
  input: AppealOutcomeNoticeInput,
  store: ModerationNoticeStore = services.notices,
): Promise<ModerationNoticeRecord> {
  const notice = await store.insert({
    userId: input.userId,
    kind: 'appeal_outcome',
    actionId: input.actionId,
    title: OUTCOME_TITLE[input.appealStatus],
    body: `${input.explanation} ${SUPPORT_LINE}`,
    reasonCode: input.reasonCode,
    appealable: false,
    appealStatus: input.appealStatus,
    readAt: null,
  });
  services.metrics.increment('notices.appeal_outcome');
  return notice;
}

/** Project a notice record to its wire view. */
export function noticeToView(record: ModerationNoticeRecord): ModerationNoticeView {
  return {
    notice_id: record.noticeId,
    kind: record.kind,
    action_id: record.actionId,
    title: record.title,
    body: record.body,
    reason_code: (record.reasonCode as ModerationReasonCode | null) ?? null,
    appealable: record.appealable,
    appeal_status: record.appealStatus,
    created_at: record.createdAt,
    read_at: record.readAt,
  };
}

/** Build the inbox response (newest first, keyset by createdAt). */
export async function listNotices(
  services: ModerationServices,
  userId: string,
  afterCreatedAt: string | null,
  limit: number,
): Promise<ModerationNoticeListResponse> {
  const records = await services.notices.listByUser(userId, afterCreatedAt, limit + 1);
  const page = records.slice(0, limit);
  const nextCursor = records.length > limit ? (page.at(-1)?.createdAt ?? null) : null;
  return {
    notices: page.map(noticeToView),
    next_cursor: nextCursor,
    unread_count: await services.notices.unreadCount(userId),
  };
}
