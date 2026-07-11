// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapter for the WS-T.6 reply-notification inbox, behind
// the same `ReplyNotificationStore` interface as the in-memory adapter: the
// inbox survives restarts/deploys and reads identically from every replica.
// Enqueue is idempotent per comment (unique index; a concurrent duplicate
// resolves to the existing row) and prunes the recipient's inbox to the newest
// N rows, so growth stays bounded without a sweep job.
import { randomUUID } from 'node:crypto';
import { type createDbClient, replyNotifications as replyNotificationsTable } from '@licio/db';
import type { ReplyNotification } from '@licio/shared';
import { and, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import {
  REPLY_NOTIFICATIONS_PER_USER_CAP,
  type ReplyNotificationCreate,
  type ReplyNotificationStore,
  toPublicNotification,
} from './reply-notifications.js';

type Db = ReturnType<typeof createDbClient>;

const iso = (d: Date): string => d.toISOString();

export class DrizzleReplyNotificationStore implements ReplyNotificationStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toPublic(row: typeof replyNotificationsTable.$inferSelect): ReplyNotification {
    return toPublicNotification({
      notification_id: row.notificationId,
      recipient_user_id: row.recipientUserId,
      kind: 'reply',
      story_id: row.storyId,
      thread_id: row.threadId,
      comment_id: row.commentId,
      parent_comment_id: row.parentCommentId,
      actor_handle: row.actorHandle,
      created_at: iso(row.createdAt),
      read_at: row.readAt ? iso(row.readAt) : null,
    });
  }

  async enqueue(input: ReplyNotificationCreate): Promise<ReplyNotification> {
    const inserted = await this.#db
      .insert(replyNotificationsTable)
      .values({
        notificationId: randomUUID(),
        recipientUserId: input.recipientUserId,
        storyId: input.storyId,
        threadId: input.threadId,
        commentId: input.commentId,
        parentCommentId: input.parentCommentId,
        actorHandle: input.actorHandle,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: replyNotificationsTable.commentId })
      .returning();
    const row = inserted[0];
    if (!row) {
      // Idempotent re-enqueue: the comment already has its notification.
      const existing = await this.#db
        .select()
        .from(replyNotificationsTable)
        .where(eq(replyNotificationsTable.commentId, input.commentId))
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('reply notification vanished during idempotent enqueue');
      return this.#toPublic(found);
    }
    // Bound the recipient's inbox to the newest N rows.
    const keep = this.#db
      .select({ id: replyNotificationsTable.notificationId })
      .from(replyNotificationsTable)
      .where(eq(replyNotificationsTable.recipientUserId, input.recipientUserId))
      .orderBy(
        desc(replyNotificationsTable.createdAt),
        desc(replyNotificationsTable.notificationId),
      )
      .limit(REPLY_NOTIFICATIONS_PER_USER_CAP);
    await this.#db
      .delete(replyNotificationsTable)
      .where(
        and(
          eq(replyNotificationsTable.recipientUserId, input.recipientUserId),
          notInArray(replyNotificationsTable.notificationId, keep),
        ),
      );
    return this.#toPublic(row);
  }

  async listForUser(userId: string, limit = 50): Promise<ReplyNotification[]> {
    const rows = await this.#db
      .select()
      .from(replyNotificationsTable)
      .where(eq(replyNotificationsTable.recipientUserId, userId))
      .orderBy(
        desc(replyNotificationsTable.createdAt),
        desc(replyNotificationsTable.notificationId),
      )
      .limit(limit);
    return rows.map((row) => this.#toPublic(row));
  }

  async unreadCount(userId: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(replyNotificationsTable)
      .where(
        and(
          eq(replyNotificationsTable.recipientUserId, userId),
          isNull(replyNotificationsTable.readAt),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async markRead(notificationId: string, userId: string): Promise<boolean> {
    // Owner-scoped; idempotent (an already-read notification keeps its stamp).
    const rows = await this.#db
      .update(replyNotificationsTable)
      .set({ readAt: sql`coalesce(${replyNotificationsTable.readAt}, now())` })
      .where(
        and(
          eq(replyNotificationsTable.notificationId, notificationId),
          eq(replyNotificationsTable.recipientUserId, userId),
        ),
      )
      .returning({ id: replyNotificationsTable.notificationId });
    return rows.length > 0;
  }

  async reset(): Promise<void> {
    await this.#db.delete(replyNotificationsTable);
  }
}
