// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J HTTP route tests: the user-facing endpoints (reports, blocks, mutes,
// appeals, support contact, notice inbox) and the role-gated console (queue,
// review, action palette, revert, appeals, audit, export, config) wired through
// the real v1 router with authenticated sessions + doctrine steward roles.
import { randomUUID } from 'node:crypto';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
  type StewardRoleId,
} from '@licio/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '../identity/rbac.js';
import type { IdentityServices } from '../identity/services.js';
import { buildSessionCookie, createSession } from '../identity/sessions.js';
import type {
  ModerationContentPort,
  ModerationUserPort,
  ResolvedUser,
} from '../moderation/ports.js';
import {
  createInMemoryModerationServices,
  resetModerationServicesForTests,
  setModerationServices,
} from '../moderation/services.js';
import { createV1Routes } from '../routes/v1.js';
import { freshEventServices } from './event-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let identity: IdentityServices;
let AUTHOR = '';
let AUTHOR_COOKIE = '';
const alerts: Array<{ kind: string }> = [];

function userPortOverIdentity(): ModerationUserPort {
  const resolve = async (id: string): Promise<ResolvedUser | null> => {
    const u = await identity.store.getUser(id);
    if (!u) return null;
    return {
      handle: u.handle,
      accountAgeDays: Math.max(0, Math.floor((Date.now() - Date.parse(u.createdAt)) / 86_400_000)),
      contributionCount: 0,
      contributionTypes: {},
      roomsActiveIn: 0,
    };
  };
  return {
    resolve,
    async resolveMany(ids) {
      const out = new Map<string, ResolvedUser>();
      for (const id of ids) {
        const r = await resolve(id);
        if (r) out.set(id, r);
      }
      return out;
    },
  };
}

/** Content port that maps every content target to the seeded AUTHOR. */
function stubContentPort(): ModerationContentPort {
  return {
    async resolveTarget(targetType, targetId) {
      if (targetType === 'account')
        return { exists: true, subjectUserId: targetId, contentKind: null };
      return { exists: true, subjectUserId: AUTHOR, contentKind: 'contribution' };
    },
    async applyContentState() {},
    async applyAccountState() {},
    async contentSnapshot() {
      return null;
    },
    async threadContext() {
      return { items: [], reportedContributionId: null };
    },
  };
}

async function seedUser(opts: {
  handle: string;
  platformRoles?: Role[];
  stewardRoles?: StewardRoleId[];
  steward?: boolean;
}): Promise<{ userId: string; cookie: string }> {
  const user = await identity.store.createUser({
    handle: opts.handle,
    displayName: opts.handle,
    email: null,
    accountState: 'active',
    locale: null,
    ageBand: 'adult',
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    reputationSummary: emptyReputationSummary(),
    roles: opts.platformRoles ?? ['user'],
    stewardRoles: opts.stewardRoles ?? [],
  });
  await identity.store.addWebauthn({
    credentialId: `cred-${user.userId}`,
    userId: user.userId,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    deviceType: 'platform',
    deviceName: null,
    transports: [],
    backedUp: false,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  const platformRoles = opts.platformRoles ?? ['user'];
  const isSteward =
    opts.steward ??
    ((opts.stewardRoles?.length ?? 0) > 0 ||
      platformRoles.includes('admin') ||
      platformRoles.includes('steward'));
  if (isSteward) await identity.store.setAuth(user.userId, { mfaEnabled: true });
  const created = await createSession(identity.sessions, {
    userId: user.userId,
    authMethod: 'webauthn',
    credentialRef: `cred-${user.userId}`,
    deviceLabel: 'test',
    rememberMe: false,
    mfaVerified: isSteward,
  });
  return {
    userId: user.userId,
    cookie: buildSessionCookie(created.token, created.maxAgeSec).split(';')[0] as string,
  };
}

const json = (cookie?: string) => ({
  'content-type': 'application/json',
  ...(cookie ? { cookie } : {}),
});
const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: json(cookie),
    body: JSON.stringify(body),
  });
const del = (path: string, cookie?: string) =>
  new Request(`http://localhost${path}`, { method: 'DELETE', headers: json(cookie) });
const get = (path: string, cookie?: string) =>
  new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });

beforeEach(async () => {
  alerts.length = 0;
  ({ identity } = freshEventServices());
  const author = await seedUser({ handle: `author${randomUUID().slice(0, 6)}` });
  AUTHOR = author.userId;
  AUTHOR_COOKIE = author.cookie;
  setModerationServices(
    createInMemoryModerationServices({
      content: stubContentPort(),
      users: userPortOverIdentity(),
      alerts: { pageOnCall: (i) => alerts.push(i) },
    }),
  );
});
afterEach(() => {
  resetModerationServicesForTests();
});

const reportBody = (over: Record<string, unknown> = {}) => ({
  target_type: 'content',
  target_id: randomUUID(),
  content_kind: 'contribution',
  reason_code: 'MOD_HARASS_001',
  local_operation_id: randomUUID(),
  ...over,
});

describe('POST /v1/reports', () => {
  it('rejects unauthenticated', async () => {
    const res = await app().request(post('/v1/reports', reportBody()));
    expect(res.status).toBe(401);
  });

  it('creates a report and returns severity + routing', async () => {
    const { cookie } = await seedUser({ handle: `r${randomUUID().slice(0, 6)}` });
    const res = await app().request(post('/v1/reports', reportBody(), cookie));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { severity: string; routed_to: string; report_id: string };
    expect(body.severity).toBe('moderate');
    expect(body.routed_to).toBe('standard');
    expect(body.report_id).toMatch(/[0-9a-f-]{36}/);
  });

  it('is idempotent for a repeated operation id (200, original report)', async () => {
    const { cookie } = await seedUser({ handle: `r${randomUUID().slice(0, 6)}` });
    const op = randomUUID();
    const a = await app().request(
      post('/v1/reports', reportBody({ local_operation_id: op }), cookie),
    );
    const b = await app().request(
      post('/v1/reports', reportBody({ local_operation_id: op }), cookie),
    );
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(((await b.json()) as { idempotent: boolean }).idempotent).toBe(true);
  });

  it('404s an account report against a non-existent target', async () => {
    const { cookie } = await seedUser({ handle: `r${randomUUID().slice(0, 6)}` });
    const res = await app().request(
      post(
        '/v1/reports',
        reportBody({ target_type: 'account', target_id: randomUUID(), content_kind: undefined }),
        cookie,
      ),
    );
    expect(res.status).toBe(404);
  });

  it('emergency reason codes page on-call', async () => {
    const { cookie } = await seedUser({ handle: `r${randomUUID().slice(0, 6)}` });
    await app().request(post('/v1/reports', reportBody({ reason_code: 'MOD_THREAT_001' }), cookie));
    expect(alerts.some((a) => a.kind === 'emergency_report')).toBe(true);
  });
});

describe('GET /v1/support-contact (unauthenticated)', () => {
  it('returns safety email + resources without a session', async () => {
    const res = await app().request(get('/v1/support-contact'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { safety_email: string; emergency_resources: unknown[] };
    expect(body.safety_email).toContain('@');
    expect(body.emergency_resources.length).toBeGreaterThan(0);
  });
});

describe('blocks + mutes', () => {
  it('blocks, lists, and unblocks; rejects self-block and unknown user', async () => {
    const a = await seedUser({ handle: `a${randomUUID().slice(0, 6)}` });
    const created = await app().request(post('/v1/blocks', { blocked_user_id: AUTHOR }, a.cookie));
    expect(created.status).toBe(201);
    const blockId = ((await created.json()) as { block_id: string }).block_id;

    const list = await app().request(get('/v1/blocks', a.cookie));
    expect(((await list.json()) as { blocks: unknown[] }).blocks).toHaveLength(1);

    const self = await app().request(post('/v1/blocks', { blocked_user_id: a.userId }, a.cookie));
    expect(self.status).toBe(400);
    const unknown = await app().request(
      post('/v1/blocks', { blocked_user_id: randomUUID() }, a.cookie),
    );
    expect(unknown.status).toBe(404);

    const removed = await app().request(del(`/v1/blocks/${blockId}`, a.cookie));
    expect(removed.status).toBe(200);
  });

  it('mutes with a duration and lists it', async () => {
    const a = await seedUser({ handle: `a${randomUUID().slice(0, 6)}` });
    const created = await app().request(
      post('/v1/mutes', { muted_user_id: AUTHOR, duration: '7d' }, a.cookie),
    );
    expect(created.status).toBe(201);
    expect(((await created.json()) as { expires_at: string | null }).expires_at).not.toBeNull();
  });
});

describe('moderation console (role-gated)', () => {
  it('forbids a non-steward and an evidence-only steward from the report queue', async () => {
    const plain = await seedUser({ handle: `p${randomUUID().slice(0, 6)}` });
    const plainRes = await app().request(get('/v1/moderation/queue', plain.cookie));
    expect(plainRes.status).toBe(403);

    const evidence = await seedUser({
      handle: `e${randomUUID().slice(0, 6)}`,
      stewardRoles: ['ROLE_EVIDENCE'],
    });
    const evRes = await app().request(get('/v1/moderation/queue', evidence.cookie));
    expect(evRes.status).toBe(403); // holds a steward role, but not report-queue access
  });

  it('ROLE_SAFETY reviews + removes; the author is notified and appeals; ROLE_APPEALS overturns', async () => {
    const reporter = await seedUser({ handle: `rep${randomUUID().slice(0, 6)}` });
    const targetId = randomUUID();
    expect(
      (
        await app().request(
          post('/v1/reports', reportBody({ target_id: targetId }), reporter.cookie),
        )
      ).status,
    ).toBe(201);

    const safety = await seedUser({
      handle: `saf${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_SAFETY'],
    });
    const queue = await app().request(get('/v1/moderation/queue', safety.cookie));
    expect(queue.status).toBe(200);
    const caseId = ((await queue.json()) as { standard: Array<{ case_id: string }> }).standard[0]
      ?.case_id;
    expect(caseId).toBeTruthy();

    // The review panel shows reporter identity to ROLE_SAFETY.
    const review = await app().request(get(`/v1/moderation/cases/${caseId}`, safety.cookie));
    expect(review.status).toBe(200);
    expect(
      ((await review.json()) as { reports: Array<{ reporter_handle: string | null }> }).reports[0]
        ?.reporter_handle,
    ).not.toBeNull();

    const action = await app().request(
      post(
        '/v1/moderation/actions',
        {
          target_type: 'content',
          target_id: targetId,
          action: 'remove',
          reason_code: 'MOD_HARASS_002',
          case_id: caseId,
        },
        safety.cookie,
      ),
    );
    expect(action.status).toBe(201);

    // The author (the stub content subject) sees the statement of reasons.
    const inbox = await app().request(get('/v1/moderation/notices', AUTHOR_COOKIE));
    const notices = (await inbox.json()) as {
      notices: Array<{ action_id: string; appealable: boolean }>;
      unread_count: number;
    };
    expect(notices.unread_count).toBe(1);
    const actionId = notices.notices[0]?.action_id;
    expect(notices.notices[0]?.appealable).toBe(true);

    // The author appeals.
    const appeal = await app().request(
      post(
        '/v1/appeals',
        { action_id: actionId, user_statement: 'This did not violate policy.' },
        AUTHOR_COOKIE,
      ),
    );
    expect(appeal.status).toBe(201);
    const appealId = ((await appeal.json()) as { appeal_id: string }).appeal_id;

    // A DIFFERENT person (ROLE_APPEALS) decides — independence holds.
    const appeals = await seedUser({
      handle: `app${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_APPEALS'],
    });
    const decision = await app().request(
      post(
        `/v1/moderation/appeals/${appealId}/decision`,
        {
          decision: 'overturn',
          reason_code: 'MOD_HARASS_001',
          explanation: 'Overturned on review.',
        },
        appeals.cookie,
      ),
    );
    expect(decision.status).toBe(200);
    expect(((await decision.json()) as { status: string }).status).toBe('overturned');

    // The author now has an appeal-outcome notice too.
    const inbox2 = await app().request(get('/v1/moderation/notices', AUTHOR_COOKIE));
    expect(
      ((await inbox2.json()) as { notices: Array<{ kind: string }> }).notices.some(
        (n) => n.kind === 'appeal_outcome',
      ),
    ).toBe(true);
  });

  it('ROLE_SAFETY cannot access the appeal queue (separation)', async () => {
    const safety = await seedUser({
      handle: `saf${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_SAFETY'],
    });
    expect((await app().request(get('/v1/moderation/appeals', safety.cookie))).status).toBe(403);
    const appeals = await seedUser({
      handle: `app${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_APPEALS'],
    });
    expect((await app().request(get('/v1/moderation/appeals', appeals.cookie))).status).toBe(200);
  });

  it('ROLE_COMMUNITY cannot remove content (capability gate)', async () => {
    const community = await seedUser({
      handle: `com${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_COMMUNITY'],
    });
    const res = await app().request(
      post(
        '/v1/moderation/actions',
        {
          target_type: 'content',
          target_id: randomUUID(),
          action: 'remove',
          reason_code: 'MOD_HARASS_001',
        },
        community.cookie,
      ),
    );
    expect(res.status).toBe(403);
  });

  it('an admin can read the audit log and export a suppressed transparency report', async () => {
    const admin = await seedUser({
      handle: `adm${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'admin'],
    });
    // Take an action to populate the audit log.
    await app().request(
      post(
        '/v1/moderation/actions',
        {
          target_type: 'content',
          target_id: randomUUID(),
          action: 'hide',
          reason_code: 'MOD_SPAM_001',
        },
        admin.cookie,
      ),
    );
    const audit = await app().request(get('/v1/moderation/audit', admin.cookie));
    expect(audit.status).toBe(200);
    expect(((await audit.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const exportRes = await app().request(get('/v1/moderation/audit/export', admin.cookie));
    expect(exportRes.status).toBe(200);
    const report = (await exportRes.json()) as { suppression_threshold: number };
    expect(report.suppression_threshold).toBeGreaterThan(0);
  });

  it('config GET/PATCH validates and persists (steward, no deploy)', async () => {
    const admin = await seedUser({
      handle: `cfg${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'admin'],
    });
    const patch = await app().request(
      new Request('http://localhost/v1/moderation/config', {
        method: 'PATCH',
        headers: json(admin.cookie),
        body: JSON.stringify({ reportsPerHour: 25 }),
      }),
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { reportsPerHour: number }).reportsPerHour).toBe(25);

    const invalid = await app().request(
      new Request('http://localhost/v1/moderation/config', {
        method: 'PATCH',
        headers: json(admin.cookie),
        body: JSON.stringify({ reportsPerHour: -1 }),
      }),
    );
    expect(invalid.status).toBe(422);
  });
});
