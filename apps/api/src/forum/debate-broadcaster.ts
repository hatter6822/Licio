// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T live debate-arena broadcast port.  Frames carry the OBSERVER projection of
// the arena (no per-viewer is_author flags cross the boundary); each client
// re-fetches its own role-scoped view on the nudge.  This is what makes each
// side's position draft co-visible to the other AS THEY EDIT (SPEC §15.4/§24.6),
// and pushes the verdict + resolution live.  No scores, raw attention fields, or
// wallet/payment state cross this boundary.
import { type DebateArenaPublic, debateArenaPublicSchema } from '@licio/shared';

export interface DebateFrame {
  /** SSE `id:` key — the arena's `updated_at` (monotone within one arena). */
  eventId: string;
  arena: DebateArenaPublic;
}

export type DebateFrameHandler = (frame: DebateFrame) => void | Promise<void>;

export interface DebateBroadcaster {
  publish(debateId: string, arena: DebateArenaPublic): void;
  subscribe(debateId: string, handler: DebateFrameHandler): () => void;
}

class DebateEvent extends Event {
  readonly debateId: string;
  readonly frame: DebateFrame;

  constructor(debateId: string, frame: DebateFrame) {
    super('debate');
    this.debateId = debateId;
    this.frame = frame;
  }
}

/** Single-process/dev/e2e adapter.  Production can swap this with Redis pub/sub. */
export class InMemoryDebateBroadcaster implements DebateBroadcaster {
  readonly #target = new EventTarget();

  publish(debateId: string, arena: DebateArenaPublic): void {
    const validated = debateArenaPublicSchema.parse(arena);
    if (validated.debate_id !== debateId) return;
    this.#target.dispatchEvent(
      new DebateEvent(debateId, { eventId: validated.updated_at, arena: validated }),
    );
  }

  subscribe(debateId: string, handler: DebateFrameHandler): () => void {
    const listener = (event: Event): void => {
      if (!(event instanceof DebateEvent) || event.debateId !== debateId) return;
      Promise.resolve(handler(event.frame)).catch(() => {
        // Subscribers own their transport; one failed write must not break fan-out.
      });
    };
    this.#target.addEventListener('debate', listener);
    return () => this.#target.removeEventListener('debate', listener);
  }
}

/** One SSE frame for a debate update (id + a JSON observer-arena payload). */
export function sseDebateFrame(frame: DebateFrame): string {
  return `id: ${frame.eventId}\nevent: debate\ndata: ${JSON.stringify(frame.arena)}\n\n`;
}
