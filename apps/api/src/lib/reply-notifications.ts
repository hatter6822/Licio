// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.6 in-app reply notifications behind the `ReplyNotificationStore`
// boundary: the in-memory adapter serves dev/tests, and the production boot
// swaps in the Drizzle adapter (lib/drizzle-reply-notification-store.ts) so a
// user's notification inbox survives restarts/deploys and reads identically
// from every replica.  Records carry ids + actor handle only: no comment body,
// no scores, no raw attention data, no financial fields.
import { randomUUID } from 'node:crypto';
import { type ReplyNotification, replyNotificationSchema } from '@licio/shared';

export interface ReplyNotificationCreate {
  recipientUserId: string;
  storyId: string;
  threadId: string;
  commentId: string;
  parentCommentId: string;
  actorHandle: string;
}

export interface StoredReplyNotification extends ReplyNotification {
  recipient_user_id: string;
}

/** Per-recipient inbox bound: enqueue prunes rows beyond the newest N, so the
 *  inbox stays bounded without a dedicated sweep job. */
export const REPLY_NOTIFICATIONS_PER_USER_CAP = 200;

export interface ReplyNotificationStore {
  /** Idempotent per comment: a re-enqueue returns the existing notification. */
  enqueue(input: ReplyNotificationCreate): Promise<ReplyNotification>;
  listForUser(userId: string, limit?: number): Promise<ReplyNotification[]>;
  unreadCount(userId: string): Promise<number>;
  /** Mark read (owner-scoped); true when the notification belongs to the user. */
  markRead(notificationId: string, userId: string): Promise<boolean>;
  reset(): Promise<void>;
}

/** The public projection (schema-validated on every egress). */
export function toPublicNotification(item: StoredReplyNotification): ReplyNotification {
  return replyNotificationSchema.parse({
    notification_id: item.notification_id,
    kind: item.kind,
    story_id: item.story_id,
    thread_id: item.thread_id,
    comment_id: item.comment_id,
    parent_comment_id: item.parent_comment_id,
    actor_handle: item.actor_handle,
    created_at: item.created_at,
    read_at: item.read_at,
  });
}

export class InMemoryReplyNotificationStore implements ReplyNotificationStore {
  readonly #items = new Map<string, StoredReplyNotification>();
  readonly #byComment = new Map<string, string>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async enqueue(input: ReplyNotificationCreate): Promise<ReplyNotification> {
    const existingId = this.#byComment.get(input.commentId);
    if (existingId) {
      return toPublicNotification(this.#items.get(existingId) as StoredReplyNotification);
    }
    const item: StoredReplyNotification = {
      notification_id: randomUUID(),
      recipient_user_id: input.recipientUserId,
      kind: 'reply',
      story_id: input.storyId,
      thread_id: input.threadId,
      comment_id: input.commentId,
      parent_comment_id: input.parentCommentId,
      actor_handle: input.actorHandle,
      created_at: new Date(this.#now()).toISOString(),
      read_at: null,
    };
    const parsed = toPublicNotification(item);
    this.#items.set(item.notification_id, item);
    this.#byComment.set(item.comment_id, item.notification_id);
    // Bound the recipient's inbox to the newest N.
    const forUser = [...this.#items.values()]
      .filter((row) => row.recipient_user_id === input.recipientUserId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const stale of forUser.slice(REPLY_NOTIFICATIONS_PER_USER_CAP)) {
      this.#items.delete(stale.notification_id);
      this.#byComment.delete(stale.comment_id);
    }
    return parsed;
  }

  async listForUser(userId: string, limit = 50): Promise<ReplyNotification[]> {
    return [...this.#items.values()]
      .filter((item) => item.recipient_user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((item) => toPublicNotification(item));
  }

  async unreadCount(userId: string): Promise<number> {
    return [...this.#items.values()].filter(
      (item) => item.recipient_user_id === userId && item.read_at === null,
    ).length;
  }

  async markRead(notificationId: string, userId: string): Promise<boolean> {
    const item = this.#items.get(notificationId);
    if (!item || item.recipient_user_id !== userId) return false;
    if (item.read_at === null) item.read_at = new Date(this.#now()).toISOString();
    return true;
  }

  async reset(): Promise<void> {
    this.#items.clear();
    this.#byComment.clear();
  }
}

let store: ReplyNotificationStore = new InMemoryReplyNotificationStore();

/** Bind the durable adapter (production boot) or a fresh in-memory one (tests). */
export function setReplyNotificationStore(next: ReplyNotificationStore): void {
  store = next;
}

/** The module facade every route/consumer calls — reads THROUGH the bound store. */
export const replyNotifications: ReplyNotificationStore = {
  enqueue: (input) => store.enqueue(input),
  listForUser: (userId, limit) => store.listForUser(userId, limit),
  unreadCount: (userId) => store.unreadCount(userId),
  markRead: (notificationId, userId) => store.markRead(notificationId, userId),
  reset: () => store.reset(),
};
