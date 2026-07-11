// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.5 live comment broadcast port.  Frames carry the SAME public
// contribution projection as the REST comment read model; no scores, raw
// attention fields, wallet/payment fields, or private relationship state cross
// this boundary.
import { type ContributionPublic, contributionPublicSchema } from '@licio/shared';

export interface CommentFrame {
  /** SSE `id:` / Last-Event-ID resume key. */
  eventId: string;
  contribution: ContributionPublic;
}

export type CommentFrameHandler = (frame: CommentFrame) => void | Promise<void>;

export interface CommentBroadcaster {
  publish(threadId: string, frame: CommentFrame): void;
  /** Resolves (or returns) once the subscription is LIVE on the transport —
   *  the Redis adapter resolves after the SUBSCRIBE ack, so a caller that
   *  awaits before taking its replay snapshot can never lose a frame in the
   *  subscribe/ack gap.  The in-memory adapter is synchronously live. */
  subscribe(threadId: string, handler: CommentFrameHandler): (() => void) | Promise<() => void>;
}

class CommentEvent extends Event {
  readonly frame: CommentFrame;

  constructor(frame: CommentFrame) {
    super('comment');
    this.frame = frame;
  }
}

function topicOf(threadId: string): string {
  return `comments:${threadId}`;
}

function validateFrame(frame: CommentFrame): CommentFrame {
  const contribution = contributionPublicSchema.parse(frame.contribution);
  return { eventId: contribution.contribution_id, contribution };
}

/** Single-process/dev/e2e adapter. Production can swap this with Redis pub/sub. */
export class InMemoryCommentBroadcaster implements CommentBroadcaster {
  readonly #target = new EventTarget();

  publish(threadId: string, frame: CommentFrame): void {
    const validated = validateFrame(frame);
    if (validated.contribution.thread_id !== threadId) return;
    this.#target.dispatchEvent(new CommentEvent(validated));
  }

  subscribe(threadId: string, handler: CommentFrameHandler): () => void {
    const topic = topicOf(threadId);
    const listener = (event: Event) => {
      if (!(event instanceof CommentEvent)) return;
      if (topicOf(event.frame.contribution.thread_id) !== topic) return;
      Promise.resolve(handler(event.frame)).catch(() => {
        // Subscribers own their transport; one failed write must not break fan-out.
      });
    };
    this.#target.addEventListener('comment', listener);
    return () => this.#target.removeEventListener('comment', listener);
  }
}
