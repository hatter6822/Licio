// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Draft persistence with transparent at-rest encryption (WS-C.2.2c / §6.8).
// saveDraft encrypts the composer body before it touches IndexedDB; loadDraft
// decrypts it back. Encryption is best-effort: where Web Crypto is unavailable
// the draft is stored as plaintext (encrypted: false) so it is never lost.
import { decryptDraftValues, encryptDraftValues } from './draft-crypto.js';
import {
  type DraftContributionRecord,
  type DraftStoryRecord,
  RECORD_SCHEMA_VERSION,
} from './schemas.js';
import { draftContributions, draftStories } from './store.js';

export interface DraftInput {
  draftId: string;
  storyId: string | null;
  threadId: string | null;
  contributionType: DraftContributionRecord['contributionType'];
  values: Record<string, string>;
}

/** Persist a draft, encrypting the body at rest when Web Crypto is available. */
export async function saveDraft(input: DraftInput): Promise<void> {
  const cipher = await encryptDraftValues(input.values);
  const base = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    draftId: input.draftId,
    storyId: input.storyId,
    threadId: input.threadId,
    contributionType: input.contributionType,
    updatedAt: Date.now(),
  } as const;
  if (cipher) {
    await draftContributions.put({ ...base, values: {}, encrypted: true, cipher });
  } else {
    // Web Crypto unavailable — never lose the draft (availability > confidentiality).
    await draftContributions.put({ ...base, values: input.values, encrypted: false });
  }
}

/** Draft retention bound (WS-G.3.7c): stale drafts auto-delete on start. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Drafts for a thread (newest first), decrypted — the recovery prompt input. */
export async function listDraftsForThread(
  threadId: string | null,
): Promise<DraftContributionRecord[]> {
  const all = await draftContributions.getAll();
  const matches = all
    .filter((record) => record.threadId === threadId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const out: DraftContributionRecord[] = [];
  for (const record of matches) {
    if (record.encrypted && record.cipher) {
      const values = await decryptDraftValues(record.cipher);
      out.push({ ...record, values: values ?? {} });
    } else {
      out.push(record);
    }
  }
  return out;
}

/** Discard a draft (the recovery prompt's "discard"; post-submit cleanup). */
export async function deleteDraft(draftId: string): Promise<void> {
  await draftContributions.delete(draftId);
}

/** WS-G.3.7c expiry: delete drafts older than 30 days (called on app start).
 *  Covers BOTH contribution drafts and story-composer drafts (WS-Q.5.1b). */
export async function expireOldDrafts(now: number = Date.now()): Promise<number> {
  let removed = 0;
  const contributions = await draftContributions.getAll();
  for (const record of contributions) {
    if (now - record.updatedAt > DRAFT_MAX_AGE_MS) {
      await draftContributions.delete(record.draftId);
      removed += 1;
    }
  }
  const stories = await draftStories.getAll();
  for (const record of stories) {
    if (now - record.updatedAt > DRAFT_MAX_AGE_MS) {
      await draftStories.delete(record.draftId);
      removed += 1;
    }
  }
  return removed;
}

/** Load a draft, decrypting the body when it was stored encrypted. */
export async function loadDraft(draftId: string): Promise<DraftContributionRecord | undefined> {
  const record = await draftContributions.get(draftId);
  if (!record) return undefined;
  if (record.encrypted && record.cipher) {
    const values = await decryptDraftValues(record.cipher);
    // A decrypt failure (tamper/wrong key) yields empty values rather than throwing.
    return { ...record, values: values ?? {} };
  }
  return record;
}

// --- Story-composer drafts (WS-Q.5.1b) -------------------------------------
// The story composer owns its own state (mode + room + visibility + text), so
// it autosaves through a parallel, equally-encrypted store. Mode/room/visibility
// are plaintext metadata (they must round-trip on restore); the text body is
// encrypted exactly like a contribution draft.

export interface StoryDraftInput {
  draftId: string;
  mode: DraftStoryRecord['mode'];
  roomId: string;
  visibility: DraftStoryRecord['visibility'];
  values: Record<string, string>;
}

/** Persist a story draft, encrypting the text body at rest when available. */
export async function saveStoryDraft(input: StoryDraftInput): Promise<void> {
  const cipher = await encryptDraftValues(input.values);
  const base = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    draftId: input.draftId,
    mode: input.mode,
    roomId: input.roomId,
    visibility: input.visibility,
    updatedAt: Date.now(),
  } as const;
  if (cipher) {
    await draftStories.put({ ...base, values: {}, encrypted: true, cipher });
  } else {
    // Web Crypto unavailable — never lose the draft (availability > confidentiality).
    await draftStories.put({ ...base, values: input.values, encrypted: false });
  }
}

/** All story drafts (newest first), decrypted — the recovery-prompt input. */
export async function listStoryDrafts(): Promise<DraftStoryRecord[]> {
  const all = await draftStories.getAll();
  const matches = all.sort((a, b) => b.updatedAt - a.updatedAt);
  const out: DraftStoryRecord[] = [];
  for (const record of matches) {
    if (record.encrypted && record.cipher) {
      const values = await decryptDraftValues(record.cipher);
      out.push({ ...record, values: values ?? {} });
    } else {
      out.push(record);
    }
  }
  return out;
}

/** Load one story draft, decrypting the body when it was stored encrypted. */
export async function loadStoryDraft(draftId: string): Promise<DraftStoryRecord | undefined> {
  const record = await draftStories.get(draftId);
  if (!record) return undefined;
  if (record.encrypted && record.cipher) {
    const values = await decryptDraftValues(record.cipher);
    return { ...record, values: values ?? {} };
  }
  return record;
}

/** Discard a story draft (the recovery prompt's "discard"; post-submit cleanup). */
export async function deleteStoryDraft(draftId: string): Promise<void> {
  await draftStories.delete(draftId);
}
