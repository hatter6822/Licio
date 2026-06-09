// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, resetDbConnection } from './db.js';
import { resetDraftKeyCache } from './draft-crypto.js';
import { loadDraft, saveDraft } from './drafts.js';
import { draftContributions } from './store.js';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  resetDraftKeyCache();
  resetDbConnection();
  await Promise.all([deleteDatabase(DB_NAME), deleteDatabase('licio-keys')]);
});

describe('saveDraft / loadDraft', () => {
  it('encrypts the body at rest and round-trips it on load', async () => {
    await saveDraft({
      draftId: 'd1',
      storyId: null,
      threadId: null,
      branch: null,
      contributionType: 'evidence',
      values: { headline: 'secret draft text' },
    });

    const stored = await draftContributions.get('d1');
    expect(stored?.encrypted).toBe(true);
    expect(stored?.values).toEqual({});
    expect(stored?.cipher).toBeDefined();
    // The plaintext never appears anywhere in the stored record.
    expect(JSON.stringify(stored)).not.toContain('secret draft text');

    const loaded = await loadDraft('d1');
    expect(loaded?.values).toEqual({ headline: 'secret draft text' });
  });

  it('loads a plaintext (unencrypted fallback) draft unchanged', async () => {
    await draftContributions.put({
      schemaVersion: 1,
      draftId: 'd2',
      storyId: null,
      threadId: null,
      branch: null,
      contributionType: 'evidence',
      values: { headline: 'plain' },
      updatedAt: Date.now(),
      encrypted: false,
    });
    const loaded = await loadDraft('d2');
    expect(loaded?.values).toEqual({ headline: 'plain' });
  });

  it('returns undefined for an unknown draft', async () => {
    expect(await loadDraft('missing')).toBeUndefined();
  });
});
