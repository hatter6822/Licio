// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Draft persistence with transparent at-rest encryption (WS-C.2.2c / §6.8).
// saveDraft encrypts the composer body before it touches IndexedDB; loadDraft
// decrypts it back. Encryption is best-effort: where Web Crypto is unavailable
// the draft is stored as plaintext (encrypted: false) so it is never lost.
import { decryptDraftValues, encryptDraftValues } from './draft-crypto.js';
import { type DraftContributionRecord, RECORD_SCHEMA_VERSION } from './schemas.js';
import { draftContributions } from './store.js';

export interface DraftInput {
  draftId: string;
  storyId: string | null;
  threadId: string | null;
  branch: DraftContributionRecord['branch'];
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
    branch: input.branch,
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

/** WS-G.3.7c expiry: delete drafts older than 30 days (called on app start). */
export async function expireOldDrafts(now: number = Date.now()): Promise<number> {
  const all = await draftContributions.getAll();
  let removed = 0;
  for (const record of all) {
    if (now - record.updatedAt > DRAFT_MAX_AGE_MS) {
      await draftContributions.delete(record.draftId);
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
