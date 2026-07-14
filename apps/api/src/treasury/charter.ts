// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.2a — the versioned, plain-language room charter.  Every version is
// IMMUTABLE (append-only trigger, migration 0082) and hash-committed:
// content_hash = 0x-SHA-256 over the canonical (key-sorted) sections, so a
// silent charter swap after approval is detectable by anyone re-hashing the
// stored sections.  The eight required sections — including the §16.5 safety
// override acknowledgment and the appeals path to the platform legal floor —
// are enforced structurally by the shared zod schema, so an incomplete charter
// cannot exist at rest.  Readability: sections carry a minimum length and the
// service rejects walls of legalese heuristically (average sentence length).

import { createHash } from 'node:crypto';
import { canonicalize } from '@licio/governance';
import { type CharterSections, charterSectionsSchema } from '@licio/shared';
import { appendChainedAudit } from './audit-chain.js';
import {
  assertGovernanceWritable,
  ensureProfile,
  type ProfileDeps,
  type TreasuryGovernanceError,
  tgErr,
} from './profile.js';
import type { CharterStore, CharterVersionRecord } from './stores.js';

export interface CharterDeps extends ProfileDeps {
  charters: CharterStore;
}

/** The deterministic charter content hash (0x-prefixed SHA-256). */
export function charterContentHash(sections: CharterSections): string {
  return `0x${createHash('sha256').update(canonicalize(sections), 'utf8').digest('hex')}`;
}

/** Plain-language heuristic (WS-M.1.2a): average sentence length must stay
 *  readable — a general-audience charter, not legal jargon.  Conservative bar
 *  (40 words/sentence) so ordinary prose always passes. */
export function readabilityProblems(sections: CharterSections): string[] {
  const problems: string[] = [];
  for (const [name, text] of Object.entries(sections)) {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = text.split(/\s+/).filter((w) => w.length > 0).length;
    const avg = sentences.length > 0 ? words / sentences.length : words;
    if (avg > 40) {
      problems.push(`${name}: average sentence length ${avg.toFixed(0)} words exceeds 40`);
    }
  }
  return problems;
}

const MAX_VERSION_RETRIES = 5;

/**
 * Publish a new charter version.  Version numbers are allocated optimistically
 * against the (room, version) unique index — a concurrent publisher loses the
 * insert and this retries with a re-read number, so history is strictly
 * sequential with no gaps or forks.
 */
export async function createCharterVersion(
  deps: CharterDeps,
  input: { roomId: string; sections: unknown; actorUserId: string },
): Promise<TreasuryGovernanceError | { ok: true; charter: CharterVersionRecord }> {
  // A frozen room cannot rewrite its charter mid-review (WS-M.2.4a-1: the
  // guard covers EVERY WS-M configuration mutation).
  const frozen = await assertGovernanceWritable(deps, input.roomId, 'configuration');
  if (frozen !== null) return frozen;
  const parsed = charterSectionsSchema.safeParse(input.sections);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .filter((p, i, all) => all.indexOf(p) === i)
      .join(', ');
    return tgErr(400, 'charter_incomplete', `The charter is incomplete or invalid: ${missing}.`);
  }
  const readability = readabilityProblems(parsed.data);
  if (readability.length > 0) {
    return tgErr(
      400,
      'charter_unreadable',
      `The charter must be plain language: ${readability.join('; ')}`,
    );
  }
  const contentHash = charterContentHash(parsed.data);
  for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt += 1) {
    const latest = await deps.charters.latestByRoom(input.roomId);
    const record: CharterVersionRecord = {
      charterVersionId: deps.uuid(),
      roomId: input.roomId,
      version: (latest?.version ?? 0) + 1,
      sections: parsed.data,
      contentHash,
      createdByUserId: input.actorUserId,
      createdAt: new Date(deps.now()).toISOString(),
    };
    const inserted = await deps.charters.insert(record);
    if (inserted === null) continue; // (room, version) collision — re-read + retry
    const profile = await ensureProfile(deps, input.roomId);
    // Concurrent publishes: the pointer always lands on the NEWEST version —
    // re-read the latest so a slower lower-version request can never point the
    // active profile back at an older charter.
    const newest = await deps.charters.latestByRoom(input.roomId);
    await deps.profiles.upsert({
      ...profile,
      charterVersionId: newest?.charterVersionId ?? inserted.charterVersionId,
      updatedAt: new Date(deps.now()).toISOString(),
    });
    await appendChainedAudit(deps, {
      roomId: input.roomId,
      actionType: 'charter_version_created',
      actorUserId: input.actorUserId,
      details: {
        charter_version_id: inserted.charterVersionId,
        version: inserted.version,
        content_hash: inserted.contentHash,
      },
    });
    return { ok: true, charter: inserted };
  }
  return tgErr(409, 'charter_contended', 'Charter versioning is busy; please retry.');
}
