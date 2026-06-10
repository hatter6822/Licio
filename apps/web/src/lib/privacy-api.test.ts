// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Privacy data-rights flows (WS-D.2): export request/status/download (with the
// step-up challenge surfaced as a typed error), attention deletion, and the
// account-deletion lifecycle — against the same mocked-fetch seam as
// api.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, resetApiClientState } from './api.js';
import { StepUpRequiredError } from './auth-api.js';
import {
  cancelAccountDeletion,
  deleteAttentionHistory,
  downloadExport,
  fetchDeletionStatus,
  fetchExportStatus,
  requestAccountDeletion,
  requestExport,
  saveBlob,
} from './privacy-api.js';

const realFetch = globalThis.fetch;

const JOB_ID = '33333333-3333-4333-8333-333333333333';
const JOB_STATUS = {
  job_id: JOB_ID,
  status: 'completed',
  progress_pct: 100,
  created_at: '2026-06-10T00:00:00.000Z',
  completed_at: '2026-06-10T00:01:00.000Z',
  expires_at: '2026-06-13T00:01:00.000Z',
  download_available: true,
  download_token: '1781400000000.aabbcc',
};

const GRACE_STATUS = {
  state: 'grace_period',
  requested_at: '2026-06-10T00:00:00.000Z',
  purge_at: '2026-07-10T00:00:00.000Z',
  cancellable: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];

function mockRoutes(routes: Record<string, (body: unknown) => Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/csrf-token')) return jsonResponse({ token: 'csrf-token' });
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${new URL(url, 'http://localhost').pathname}`;
    const handler = routes[key];
    if (!handler) return jsonResponse({ error: { code: 'not_found', message: 'no route' } }, 404);
    return handler(body);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetApiClientState();
  calls.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('DSAR export', () => {
  it('requests an export and parses the job status', async () => {
    mockRoutes({ 'POST /v1/privacy/export': () => jsonResponse(JOB_STATUS, 202) });
    const job = await requestExport();
    expect(job.job_id).toBe(JOB_ID);
    expect(job.download_available).toBe(true);
  });

  it('polls a job status', async () => {
    mockRoutes({
      [`GET /v1/privacy/export/${JOB_ID}`]: () =>
        jsonResponse({
          ...JOB_STATUS,
          status: 'processing',
          progress_pct: 10,
          download_available: false,
          download_token: null,
          completed_at: null,
          expires_at: null,
        }),
    });
    const job = await fetchExportStatus(JOB_ID);
    expect(job.status).toBe('processing');
  });

  it('downloads the archive blob with the signed token', async () => {
    mockRoutes({
      [`GET /v1/privacy/export/${JOB_ID}/download`]: () =>
        new Response('{"archive":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const blob = await downloadExport(JOB_ID, 'token-1');
    expect(await blob.text()).toBe('{"archive":true}');
    expect(calls[0]?.url).toContain('t=token-1');
  });

  it('surfaces a step-up challenge on download as a typed error', async () => {
    mockRoutes({
      [`GET /v1/privacy/export/${JOB_ID}/download`]: () =>
        jsonResponse({ status: 'step_up_required', methods: ['webauthn'] }, 401),
    });
    await expect(downloadExport(JOB_ID, 'token-1')).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it('surfaces an expired link as a typed ApiClientError', async () => {
    mockRoutes({
      [`GET /v1/privacy/export/${JOB_ID}/download`]: () =>
        jsonResponse({ error: { code: 'invalid_link', message: 'Download link invalid.' } }, 403),
    });
    await expect(downloadExport(JOB_ID, 'stale')).rejects.toMatchObject({ code: 'invalid_link' });
  });
});

describe('saveBlob', () => {
  it('clicks a transient object-URL anchor with the download name', () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicks: string[] = [];
    const anchor = document.createElement('a');
    anchor.click = () => clicks.push(`${anchor.href}|${anchor.download}`);
    const doc = {
      createElement: () => anchor,
      body: document.body,
    } as unknown as Document;

    saveBlob(new Blob(['x']), 'licio-export.json', doc);
    expect(clicks).toEqual(['blob:mock|licio-export.json']);
    vi.unstubAllGlobals();
  });
});

describe('attention deletion', () => {
  it('posts the mode and parses the result', async () => {
    mockRoutes({
      'POST /v1/privacy/attention/delete': () =>
        jsonResponse({ mode: 'delete', aggregates_removed: 12, affinities_reset: true }),
    });
    const result = await deleteAttentionHistory('delete');
    expect(result.aggregates_removed).toBe(12);
    expect(calls[0]?.body).toEqual({ mode: 'delete' });
  });
});

describe('account deletion lifecycle', () => {
  it('requests deletion (step-up challenge surfaced as a typed error)', async () => {
    mockRoutes({
      'POST /v1/privacy/delete-account': () =>
        jsonResponse({ status: 'step_up_required', methods: ['webauthn'] }, 401),
    });
    await expect(requestAccountDeletion()).rejects.toBeInstanceOf(StepUpRequiredError);

    mockRoutes({ 'POST /v1/privacy/delete-account': () => jsonResponse(GRACE_STATUS) });
    const status = await requestAccountDeletion();
    expect(status.state).toBe('grace_period');
  });

  it('reads the deletion status', async () => {
    mockRoutes({ 'GET /v1/privacy/delete-account/status': () => jsonResponse(GRACE_STATUS) });
    expect((await fetchDeletionStatus()).cancellable).toBe(true);
  });

  it('cancels via the emailed token (body carries it) or the session (no body)', async () => {
    mockRoutes({
      'POST /v1/privacy/delete-account/cancel': () =>
        jsonResponse({ ...GRACE_STATUS, state: 'cancelled', cancellable: false }),
    });
    await cancelAccountDeletion('tok-123');
    expect(calls[0]?.body).toEqual({ token: 'tok-123' });

    await cancelAccountDeletion();
    expect(calls[1]?.body).toEqual({});

    const failing = vi.fn(() =>
      jsonResponse({ error: { code: 'not_found', message: 'No cancellable deletion.' } }, 404),
    );
    mockRoutes({ 'POST /v1/privacy/delete-account/cancel': failing });
    await expect(cancelAccountDeletion('used')).rejects.toBeInstanceOf(ApiClientError);
  });
});
