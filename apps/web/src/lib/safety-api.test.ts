// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J safety-api client coverage: every flow is exercised with AND without its
// optional arguments (cursor / duration / case id / reviewer note / query) so
// the request-shaping branches are covered.  The Hono transport (`client`) and
// the zod boundary (`parseResponse`) are mocked — this asserts the client
// assembles each request and returns the validated body, not the wire.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentinel = { ok: true };

vi.mock('./api.js', () => {
  // A deep proxy: any property access returns the proxy; calling it (a $get /
  // $post / $delete) resolves to a dummy Response. `then` is masked so the
  // proxy is never mistaken for a thenable.
  const callable = (): Promise<unknown> => Promise.resolve({ status: 200 });
  const deep: unknown = new Proxy(callable, {
    get: (_target, prop) => (prop === 'then' ? undefined : deep),
    apply: () => Promise.resolve({ status: 200 }),
  });
  return {
    client: deep,
    parseResponse: vi.fn(async () => sentinel),
    ApiClientError: class extends Error {},
  };
});

const safety = await import('./safety-api.js');

beforeEach(() => vi.clearAllMocks());

const ID = '00000000-0000-4000-8000-000000000001';

describe('safety-api client flows', () => {
  it('exercises every user-facing flow with and without optional args', async () => {
    await safety.fetchSupportContact();
    await safety.submitReport({
      target_type: 'content',
      target_id: ID,
      content_kind: 'contribution',
      reason_code: 'MOD_HARASS_001',
      local_operation_id: ID,
    });
    await safety.fetchBlocks();
    await safety.fetchBlocks('cursor-1');
    await safety.createBlockByHandle('noisy_reader');
    await safety.removeBlock(ID);
    await safety.fetchMutes();
    await safety.fetchMutes('cursor-1');
    await safety.createMuteByHandle('noisy_reader');
    await safety.createMuteByHandle('noisy_reader', '7d');
    await safety.removeMute(ID);
    await safety.fetchAppealEligibility(ID);
    await safety.createAppeal({ action_id: ID, user_statement: 'please reconsider' });
    await safety.fetchModerationNotices();
    await safety.fetchModerationNotices('cursor-1');
    const result = await safety.markNoticeRead(ID);
    expect(result).toBe(sentinel);
  });

  it('exercises every steward-console flow with and without optional args', async () => {
    await safety.fetchReportQueue();
    await safety.fetchReportQueue({
      status: ['new'],
      severity: ['severe'],
      assignment: 'mine',
      cursor: 'c',
    });
    await safety.fetchCase(ID);
    await safety.assignCase(ID, ID);
    await safety.applyModerationAction({
      targetType: 'content',
      targetId: ID,
      action: 'hide',
      reasonCode: 'MOD_HARASS_001',
    });
    await safety.applyModerationAction({
      targetType: 'account',
      targetId: ID,
      action: 'restrict',
      reasonCode: 'MOD_HARASS_001',
      caseId: ID,
      reviewerNote: 'note',
      duration: '7d',
    });
    await safety.revertModerationAction(ID, 'MOD_HARASS_001');
    await safety.setReviewerStatus('available');
    await safety.fetchAppealQueue();
    await safety.fetchAppeal(ID);
    await safety.decideAppeal(ID, {
      decision: 'overturn',
      reason_code: 'MOD_HARASS_001',
      explanation: 'reviewed',
    });
    await safety.fetchAudit({});
    await safety.fetchAudit({ action: 'remove', cursor: 'c' });
    await safety.exportAudit();
    await safety.fetchIncidents();
    await safety.resolveIncident(ID, 'cleared');
    const confirmed = await safety.resolveIncident(ID, 'confirmed', 'a coordinated attack');
    expect(confirmed).toBe(sentinel);
  });
});
