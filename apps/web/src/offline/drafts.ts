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
