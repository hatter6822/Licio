// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgeBand } from '@licio/shared';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
  teenFloorPrivacySettings,
} from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { exportObjectKey } from '../identity/privacy-jobs.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
  type RecordingMailer,
  setIdentityServices,
} from '../identity/services.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
};

let services: IdentityServices;

/** Typed JSON reader (Node undici types Response.json() as unknown). */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const jsonHeaders = (cookie?: string): Record<string, string> => ({
  'content-type': 'application/json',
  ...(cookie ? { cookie } : {}),
});
function extractCookie(res: Response, name: string): string | undefined {
  for (const sc of res.headers.getSetCookie()) {
    const value = sc.match(new RegExp(`^${name}=([^;]*)`))?.[1];
    if (value) return `${name}=${value}`;
  }
  return undefined;
}

function seedUser(ageBand: AgeBand, email = 'p@example.com', handle = 'puser') {
  const user = services.store.createUser({
    handle,
    displayName: 'P User',
    email,
    accountState: 'active',
    locale: null,
    ageBand,
    privacySettings: ageBand === 'adult' ? defaultPrivacySettings() : teenFloorPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    reputationSummary: emptyReputationSummary(),
    roles: ['user'],
  });
  services.store.setAuth(user.userId, {
    emailVerified: true,
    emailVerifiedAt: new Date().toISOString(),
  });
  return user;
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const start = await app.request('/v1/auth/email/start', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email }),
  });
  const attempt = extractCookie(start, '__Host-otp') as string;
  const code = (services.mailer as RecordingMailer).codes.at(-1)?.code as string;
  const verify = await app.request('/v1/auth/email/verify-login', {
    method: 'POST',
    headers: jsonHeaders(attempt),
    body: JSON.stringify({ code }),
  });
  return extractCookie(verify, '__Host-sid') as string;
}

beforeEach(() => {
  services = createInMemoryIdentityServices(CONFIG);
  setIdentityServices(services);
});
afterEach(() => {
  services.store.clear();
});

describe('GET/PATCH /v1/privacy/settings', () => {
  it('returns settings and persists a personalization opt-out (audited + propagated)', async () => {
    const propagated: Array<{ personalizationEnabled: boolean }> = [];
    services.onPrivacyChange = (change) => propagated.push(change);
    seedUser('adult', 'set@example.com', 'setuser');
    const app = createApp();
    const sid = await login(app, 'set@example.com');

    const get = await app.request('/v1/privacy/settings', { headers: { cookie: sid } });
    expect(get.status).toBe(200);
    expect(
      (await readJson<{ privacy_settings: { personalization_enabled: boolean } }>(get))
        .privacy_settings.personalization_enabled,
    ).toBe(true);

    const patch = await app.request('/v1/privacy/settings', {
      method: 'PATCH',
      headers: jsonHeaders(sid),
      body: JSON.stringify({ privacy_settings: { personalization_enabled: false } }),
    });
    expect(patch.status).toBe(200);
    expect(
      (await readJson<{ privacy_settings: { personalization_enabled: boolean } }>(patch))
        .privacy_settings.personalization_enabled,
    ).toBe(false);
    // Propagated downstream (real control, not a placebo toggle).
    expect(propagated.at(-1)?.personalizationEnabled).toBe(false);
  });

  it('clamps a teen attempt to weaken below the floor (server-side)', async () => {
    seedUser('teen_13_15', 'teen@example.com', 'teenuser');
    const app = createApp();
    const sid = await login(app, 'teen@example.com');
    const patch = await app.request('/v1/privacy/settings', {
      method: 'PATCH',
      headers: jsonHeaders(sid),
      body: JSON.stringify({
        privacy_settings: {
          attention_retention_preference: 'default', // tries to weaken
          data_sharing_preferences: { analytics_opt_in: true, aggregate_signal_opt_in: true },
        },
      }),
    });
    expect(patch.status).toBe(200);
    const body = await readJson<{
      privacy_settings: {
        attention_retention_preference: string;
        data_sharing_preferences: { analytics_opt_in: boolean };
      };
      teen_floor_applied: boolean;
    }>(patch);
    expect(body.privacy_settings.attention_retention_preference).toBe('minimal'); // clamped
    expect(body.privacy_settings.data_sharing_preferences.analytics_opt_in).toBe(false);
    expect(body.teen_floor_applied).toBe(true);
  });

  it('patches the personalization settings blob (topic preferences)', async () => {
    seedUser('adult', 'pers@example.com', 'persuser');
    const app = createApp();
    const sid = await login(app, 'pers@example.com');
    const patch = await app.request('/v1/privacy/settings', {
      method: 'PATCH',
      headers: jsonHeaders(sid),
      body: JSON.stringify({ personalization_settings: { topic_preferences: ['technology'] } }),
    });
    expect(patch.status).toBe(200);
    const body = await readJson<{ personalization_settings: { topic_preferences: string[] } }>(
      patch,
    );
    expect(body.personalization_settings.topic_preferences).toEqual(['technology']);
  });
});

describe('POST /v1/privacy/attention/delete', () => {
  it('deletes attention history (delegating to the WS-E purge) and audits it', async () => {
    let purgedFor: string | null = null;
    services.purgeAttention = async (userId) => {
      purgedFor = userId;
      return 42;
    };
    const user = seedUser('adult', 'att@example.com', 'attuser');
    const app = createApp();
    const sid = await login(app, 'att@example.com');
    const res = await app.request('/v1/privacy/attention/delete', {
      method: 'POST',
      headers: jsonHeaders(sid),
      body: JSON.stringify({ mode: 'delete' }),
    });
    expect(res.status).toBe(200);
    expect((await readJson<{ aggregates_removed: number }>(res)).aggregates_removed).toBe(42);
    expect(purgedFor).toBe(user.userId);
    expect(
      (await services.audit.securityActivityForUser(user.userId)).some(
        (e) => e.event_type === 'attention_delete',
      ),
    ).toBe(true);
  });
});

describe('DSAR export', () => {
  it('creates one job, dedupes a second request, and 404s a cross-user read', async () => {
    seedUser('adult', 'exp@example.com', 'expuser');
    const other = seedUser('adult', 'other@example.com', 'otheruser');
    const app = createApp();
    const sid = await login(app, 'exp@example.com');

    const first = await app.request('/v1/privacy/export', {
      method: 'POST',
      headers: jsonHeaders(sid),
    });
    expect(first.status).toBe(202);
    const job = await readJson<{ status: string; job_id: string }>(first);
    expect(job.status).toBe('queued');

    const second = await app.request('/v1/privacy/export', {
      method: 'POST',
      headers: jsonHeaders(sid),
    });
    expect((await readJson<{ job_id: string }>(second)).job_id).toBe(job.job_id); // dedup

    const status = await app.request(`/v1/privacy/export/${job.job_id}`, {
      headers: { cookie: sid },
    });
    expect(status.status).toBe(200);

    // A job owned by another user is created directly; cross-user read → 404.
    const otherJob = services.store.createExportJob(other.userId);
    const cross = await app.request(`/v1/privacy/export/${otherJob.jobId}`, {
      headers: { cookie: sid },
    });
    expect(cross.status).toBe(404);
  });

  it('processes on first poll, then serves the archive via a signed download token', async () => {
    const user = seedUser('adult', 'dl@example.com', 'dluser');
    const app = createApp();
    const sid = await login(app, 'dl@example.com');

    const create = await app.request('/v1/privacy/export', {
      method: 'POST',
      headers: jsonHeaders(sid),
    });
    const { job_id } = await readJson<{ job_id: string }>(create);

    // First poll assembles the job (in-process worker substitute) → completed.
    const poll = await app.request(`/v1/privacy/export/${job_id}`, { headers: { cookie: sid } });
    const status = await readJson<{ status: string; download_token: string | null }>(poll);
    expect(status.status).toBe('completed');
    expect(status.download_token).toBeTruthy();

    // The signed token unlocks the encrypted archive (own data only).
    const download = await app.request(
      `/v1/privacy/export/${job_id}/download?t=${status.download_token}`,
      { headers: { cookie: sid } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('licio-export.json');
    const archive = await readJson<{ schema_version: number; account: { user_id: string } }>(
      download,
    );
    expect(archive.schema_version).toBe(1);
    expect(archive.account.user_id).toBe(user.userId);

    // A forged/again-expired token is rejected (403), never serving bytes.
    const forged = await app.request(`/v1/privacy/export/${job_id}/download?t=not-a-real-token`, {
      headers: { cookie: sid },
    });
    expect(forged.status).toBe(403);
  });

  it('returns 410 when a valid token outlives a swept archive', async () => {
    seedUser('adult', 'gone@example.com', 'goneuser');
    const app = createApp();
    const sid = await login(app, 'gone@example.com');
    const create = await app.request('/v1/privacy/export', {
      method: 'POST',
      headers: jsonHeaders(sid),
    });
    const { job_id } = await readJson<{ job_id: string }>(create);
    const poll = await app.request(`/v1/privacy/export/${job_id}`, { headers: { cookie: sid } });
    const { download_token } = await readJson<{ download_token: string }>(poll);

    // The 72h sweeper has removed the archive object, but the job is still
    // 'completed' and the (unexpired) token still verifies → 410 Gone, not 200.
    await services.objectStore.delete(exportObjectKey(job_id));
    const res = await app.request(`/v1/privacy/export/${job_id}/download?t=${download_token}`, {
      headers: { cookie: sid },
    });
    expect(res.status).toBe(410);
  });
});

describe('account deletion lifecycle', () => {
  it('requests deletion (deactivate + revoke sessions), then cancels back to active', async () => {
    const user = seedUser('adult', 'del@example.com', 'deluser');
    const app = createApp();
    const sid = await login(app, 'del@example.com');

    const del = await app.request('/v1/privacy/delete-account', {
      method: 'POST',
      headers: jsonHeaders(sid),
    });
    expect(del.status).toBe(200);
    expect((await readJson<{ state: string }>(del)).state).toBe('grace_period');
    expect(services.store.getUser(user.userId)?.accountState).toBe('deactivated');
    // Sessions were revoked → the cookie no longer authenticates.
    const afterRevoke = await app.request('/v1/privacy/delete-account/status', {
      headers: { cookie: sid },
    });
    expect(afterRevoke.status).toBe(401);
    expect(
      (services.mailer as RecordingMailer).notices.some((n) => n.kind === 'deletion_requested'),
    ).toBe(true);

    // A pending-deletion account may RE-LOGIN with a remaining method solely to
    // cancel (the session is otherwise restricted by the middleware).  No manual
    // re-activation: this exercises the real recovery path for a no-email user.
    // (Clear the 60s per-mailbox issuance cooldown the first login armed.)
    await services.otp.clear();
    const sid2 = await login(app, 'del@example.com');
    const cancel = await app.request('/v1/privacy/delete-account/cancel', {
      method: 'POST',
      headers: jsonHeaders(sid2),
    });
    expect(cancel.status).toBe(200);
    expect((await readJson<{ state: string }>(cancel)).state).toBe('none');
    expect(services.store.getUser(user.userId)?.accountState).toBe('active');
  });

  it('cancels via the emailed single-use token (no session required)', async () => {
    const user = seedUser('adult', 'tok@example.com', 'tokuser');
    const app = createApp();
    const sid = await login(app, 'tok@example.com');

    await app.request('/v1/privacy/delete-account', { method: 'POST', headers: jsonHeaders(sid) });
    const notice = (services.mailer as RecordingMailer).notices.find(
      (n) => n.kind === 'deletion_requested',
    );
    const token = notice?.payload?.['cancel_token'];
    expect(token).toBeTruthy();

    // The token cancels WITHOUT any session cookie (the user clicked an email link).
    const cancel = await app.request('/v1/privacy/delete-account/cancel', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ token }),
    });
    expect(cancel.status).toBe(200);
    expect((await readJson<{ state: string }>(cancel)).state).toBe('none');
    expect(services.store.getUser(user.userId)?.accountState).toBe('active');

    // The token is single-use: a replay finds no cancellable deletion.
    const replay = await app.request('/v1/privacy/delete-account/cancel', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ token }),
    });
    expect(replay.status).toBe(404);
  });
});
