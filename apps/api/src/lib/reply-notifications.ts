// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.6 in-app reply notifications. Records carry ids + actor handle only:
// no comment body, no scores, no raw attention data, no financial fields.
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

interface StoredReplyNotification extends ReplyNotification {
  recipient_user_id: string;
}

export class InMemoryReplyNotificationStore {
  readonly #items = new Map<string, StoredReplyNotification>();
  readonly #byComment = new Map<string, string>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  enqueue(input: ReplyNotificationCreate): ReplyNotification {
    const existingId = this.#byComment.get(input.commentId);
    if (existingId) return this.#toPublic(this.#items.get(existingId) as StoredReplyNotification);
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
    const parsed = this.#toPublic(item);
    this.#items.set(item.notification_id, item);
    this.#byComment.set(item.comment_id, item.notification_id);
    return parsed;
  }

  listForUser(userId: string, limit = 50): ReplyNotification[] {
    return [...this.#items.values()]
      .filter((item) => item.recipient_user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((item) => this.#toPublic(item));
  }

  unreadCount(userId: string): number {
    return [...this.#items.values()].filter(
      (item) => item.recipient_user_id === userId && item.read_at === null,
    ).length;
  }

  markRead(notificationId: string, userId: string): boolean {
    const item = this.#items.get(notificationId);
    if (!item || item.recipient_user_id !== userId) return false;
    if (item.read_at === null) item.read_at = new Date(this.#now()).toISOString();
    return true;
  }

  reset(): void {
    this.#items.clear();
    this.#byComment.clear();
  }

  #toPublic(item: StoredReplyNotification): ReplyNotification {
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
}

export const replyNotifications = new InMemoryReplyNotificationStore();
