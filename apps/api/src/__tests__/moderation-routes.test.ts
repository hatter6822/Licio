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
  getModerationServices,
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
    async currentAccountState() {
      return null;
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

  it('WS-N.2.3e: key-like material in the free text is BLOCKED with the warning, never stored', async () => {
    const { cookie } = await seedUser({ handle: `r${randomUUID().slice(0, 6)}` });
    const phrase =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const res = await app().request(
      post('/v1/reports', reportBody({ context: `help, my seed is ${phrase}` }), cookie),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('key_material_blocked');
    expect(body.error.message).toContain('Never share your private key or seed phrase');
    // The matched value was DISCARDED: no report row exists.
    const mod = getModerationServices();
    expect(await mod.reports.countByReporterSince('any', '2000-01-01T00:00:00.000Z')).toBe(0);
    // A 0x-prefixed 64-hex value is blocked too: it is BOTH a transaction
    // hash and a private-key export, and nothing can tell them apart. The
    // warning points at the structured evidence field for real references.
    const hex = `0x${'e9873d79c6d87dc0fb6a5778633389f4453213303da61f20bd67fc233aa33262'}`;
    const keyLike = await app().request(
      post('/v1/reports', reportBody({ context: `wrong transfer ${hex}` }), cookie),
    );
    expect(keyLike.status).toBe(422);
    // …while an ordinary report still goes through untouched.
    const ok = await app().request(
      post('/v1/reports', reportBody({ context: 'this post is spam' }), cookie),
    );
    expect(ok.status).toBe(201);
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

  it('#7 404s a content report the reporter cannot read (read bar, no existence leak)', async () => {
    const { cookie } = await seedUser({ handle: `r${randomUUID().slice(0, 6)}` });
    // A content port whose WS-Q visibility gate denies this reporter — the
    // target EXISTS but is unreadable, so the report 404s like a missing one.
    setModerationServices(
      createInMemoryModerationServices({
        content: {
          ...stubContentPort(),
          async canUserReadContent(): Promise<boolean> {
            return false;
          },
        },
        users: userPortOverIdentity(),
        alerts: { pageOnCall: (i) => alerts.push(i) },
      }),
    );
    const res = await app().request(post('/v1/reports', reportBody(), cookie));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('target_not_found');
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

describe('POST /v1/moderation/url-verdict (WS-J.2.6b reviewer link-opening check)', () => {
  it('is gated to the panels the links render in: report-queue OR evidence-queue', async () => {
    // No steward role at all → forbidden.
    const plain = await seedUser({ handle: `p${randomUUID().slice(0, 6)}` });
    const plainRes = await app().request(
      post('/v1/moderation/url-verdict', { url: 'https://example.com/x' }, plain.cookie),
    );
    expect(plainRes.status).toBe(403);

    // ROLE_EVIDENCE reviews citations and opens them (STEWARD_ROLES.md
    // "verify source provenance") — the citations render in the evidence
    // panel, so the malware pre-open check must be reachable there too.
    const evidence = await seedUser({
      handle: `e${randomUUID().slice(0, 6)}`,
      stewardRoles: ['ROLE_EVIDENCE'],
    });
    const evRes = await app().request(
      post('/v1/moderation/url-verdict', { url: 'https://example.com/x' }, evidence.cookie),
    );
    expect(evRes.status).toBe(200);

    // A steward with NEITHER queue (appeals-only) stays forbidden.
    const appeals = await seedUser({
      handle: `a${randomUUID().slice(0, 6)}`,
      stewardRoles: ['ROLE_APPEALS'],
    });
    const apRes = await app().request(
      post('/v1/moderation/url-verdict', { url: 'https://example.com/x' }, appeals.cookie),
    );
    expect(apRes.status).toBe(403);
  });

  it('reports `unavailable` when the verdict seam is unwired (fail toward flagging)', async () => {
    const safety = await seedUser({
      handle: `saf${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_SAFETY'],
    });
    const res = await app().request(
      post('/v1/moderation/url-verdict', { url: 'https://unverifiable.example/x' }, safety.cookie),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'unavailable' });
  });

  it('returns the wired redirect-chain verdict and rejects a malformed URL', async () => {
    const safety = await seedUser({
      handle: `saf${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_SAFETY'],
    });
    const checked: string[] = [];
    getModerationServices().urlVerdict = async (url) => {
      checked.push(url);
      return 'malicious';
    };
    const res = await app().request(
      post('/v1/moderation/url-verdict', { url: 'https://evil.example/payload' }, safety.cookie),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'malicious' });
    expect(checked).toEqual(['https://evil.example/payload']);
    expect(getModerationServices().metrics.snapshot()['moderation.url_verdict.malicious']).toBe(1);

    const bad = await app().request(
      post('/v1/moderation/url-verdict', { url: 'not-a-url' }, safety.cookie),
    );
    expect(bad.status).toBe(400);
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

  it('the integrity queue is ROLE_INTEGRITY-only; resolving an incident lifts the delay', async () => {
    const safety = await seedUser({
      handle: `saf${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_SAFETY'],
    });
    // A safety-only steward cannot reach the integrity queue.
    expect((await app().request(get('/v1/moderation/incidents', safety.cookie))).status).toBe(403);

    const integrity = await seedUser({
      handle: `int${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_INTEGRITY'],
    });
    // Seed a delayed case + its open incident directly on the singleton.
    const mod = getModerationServices();
    const targetId = randomUUID();
    const theCase = await mod.cases.insert({
      caseId: randomUUID(),
      targetType: 'content',
      targetId,
      contentKind: 'contribution',
      status: 'new',
      severity: 'severe',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 9,
      enforcementDelayed: true,
      resolvedActionId: null,
      slaDueAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const incident = await mod.incidents.insert({
      caseId: theCase.caseId,
      targetType: 'content',
      targetId,
      reportCount: 9,
      windowSeconds: 600,
      coordinationScore: 0.35,
      severity: 'severe',
      status: 'open',
      summary: 'aggregate, base-rate conditioned',
      reviewedAt: null,
      reviewedBy: null,
    });
    const list = await app().request(get('/v1/moderation/incidents', integrity.cookie));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { count: number }).count).toBe(1);

    const resolved = await app().request(
      post(
        `/v1/moderation/incidents/${incident.incidentId}/resolve`,
        { resolution: 'cleared' },
        integrity.cookie,
      ),
    );
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { case_status: string }).case_status).toBe('new');
    expect((await mod.cases.getById(theCase.caseId))?.enforcementDelayed).toBe(false);
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

    const getCfg = await app().request(get('/v1/moderation/config', admin.cookie));
    expect(getCfg.status).toBe(200);
    expect(((await getCfg.json()) as { reportsPerHour: number }).reportsPerHour).toBe(25);

    const invalid = await app().request(
      new Request('http://localhost/v1/moderation/config', {
        method: 'PATCH',
        headers: json(admin.cookie),
        body: JSON.stringify({ reportsPerHour: -1 }),
      }),
    );
    expect(invalid.status).toBe(422);
    // An unknown key is also a 422 with a field-level message.
    const unknown = await app().request(
      new Request('http://localhost/v1/moderation/config', {
        method: 'PATCH',
        headers: json(admin.cookie),
        body: JSON.stringify({ nope: 1 }),
      }),
    );
    expect(unknown.status).toBe(422);
  });

  it('#5 meta-audits each audit-log read (parity with export)', async () => {
    const admin = await seedUser({
      handle: `aud${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'admin'],
    });
    // The first read writes its own `audit_view` record (after building the page).
    const first = await app().request(get('/v1/moderation/audit?action=hide', admin.cookie));
    expect(first.status).toBe(200);
    // A second read, filtered to audit_view, sees the first read's meta-audit entry.
    const viewLog = await app().request(
      get('/v1/moderation/audit?action=audit_view', admin.cookie),
    );
    expect(viewLog.status).toBe(200);
    expect(((await viewLog.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('#7 config read + write require an enforcement role; the write is audited', async () => {
    // An evidence-only steward (no report/integrity queue) is refused both.
    const evidence = await seedUser({
      handle: `ev${randomUUID().slice(0, 6)}`,
      stewardRoles: ['ROLE_EVIDENCE'],
    });
    expect((await app().request(get('/v1/moderation/config', evidence.cookie))).status).toBe(403);
    const evWrite = await app().request(
      new Request('http://localhost/v1/moderation/config', {
        method: 'PATCH',
        headers: json(evidence.cookie),
        body: JSON.stringify({ reportsPerHour: 9 }),
      }),
    );
    expect(evWrite.status).toBe(403);

    // An admin writes config; the change is audited (config_update with the keys).
    const admin = await seedUser({
      handle: `cfg${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'admin'],
    });
    const ok = await app().request(
      new Request('http://localhost/v1/moderation/config', {
        method: 'PATCH',
        headers: json(admin.cookie),
        body: JSON.stringify({ reportsPerHour: 17 }),
      }),
    );
    expect(ok.status).toBe(200);
    const cfgAudit = await app().request(
      get('/v1/moderation/audit?action=config_update', admin.cookie),
    );
    expect(((await cfgAudit.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Additional route-branch coverage (error paths, edges, console palette).
// ---------------------------------------------------------------------------

describe('trust-safety route branches', () => {
  it('mute self-block, unknown user, list (cursor), and owned delete + 404', async () => {
    const a = await seedUser({ handle: `mu${randomUUID().slice(0, 6)}` });
    expect(
      (await app().request(post('/v1/mutes', { muted_user_id: a.userId }, a.cookie))).status,
    ).toBe(400); // cannot_mute_self
    expect(
      (await app().request(post('/v1/mutes', { muted_user_id: randomUUID() }, a.cookie))).status,
    ).toBe(404); // user_not_found
    const created = await app().request(post('/v1/mutes', { muted_user_id: AUTHOR }, a.cookie));
    const muteId = ((await created.json()) as { mute_id: string }).mute_id;
    const list = await app().request(get('/v1/mutes', a.cookie));
    expect(((await list.json()) as { mutes: unknown[] }).mutes).toHaveLength(1);
    expect((await app().request(del(`/v1/mutes/${muteId}`, a.cookie))).status).toBe(200);
    expect((await app().request(del(`/v1/mutes/${randomUUID()}`, a.cookie))).status).toBe(404);
    // Block delete 404 + block list.
    expect((await app().request(del(`/v1/blocks/${randomUUID()}`, a.cookie))).status).toBe(404);
    expect((await app().request(get('/v1/blocks', a.cookie))).status).toBe(200);
  });

  it('rate-limits reports once the per-hour cap is reached (429)', async () => {
    const admin = await seedUser({
      handle: `adm${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'admin'],
    });
    await app().request(
      new Request('http://localhost/v1/moderation/config', {
        method: 'PATCH',
        headers: json(admin.cookie),
        body: JSON.stringify({ reportsPerHour: 1 }),
      }),
    );
    const reporter = await seedUser({ handle: `rl${randomUUID().slice(0, 6)}` });
    expect((await app().request(post('/v1/reports', reportBody(), reporter.cookie))).status).toBe(
      201,
    );
    const limited = await app().request(post('/v1/reports', reportBody(), reporter.cookie));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { retry_after: number } }).error.retry_after).toBe(
      3600,
    );
  });

  it('appeal eligibility GET, duplicate (409), and a non-appealable lawful-basis remove (403)', async () => {
    const safety = await seedUser({
      handle: `saf${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_SAFETY'],
    });
    // A normal removal of AUTHOR's content (the stub maps content → AUTHOR).
    const remove = await app().request(
      post(
        '/v1/moderation/actions',
        {
          target_type: 'content',
          target_id: randomUUID(),
          action: 'remove',
          reason_code: 'MOD_HARASS_001',
        },
        safety.cookie,
      ),
    );
    const actionId = ((await remove.json()) as { action_id: string }).action_id;
    // Eligibility GET (owned by AUTHOR).
    const elig = await app().request(get(`/v1/appeals/eligibility/${actionId}`, AUTHOR_COOKIE));
    expect(elig.status).toBe(200);
    expect(((await elig.json()) as { appealable: boolean }).appealable).toBe(true);
    // Eligibility for an action NOT owned by the caller → 404 (no oracle).
    expect(
      (await app().request(get(`/v1/appeals/eligibility/${actionId}`, safety.cookie))).status,
    ).toBe(404);
    // WS-N.2.3e: an appeal is the OTHER free-text lane into this queue, so it
    // runs the same no-key filter the report edge does — a user pasting a seed
    // phrase while appealing would otherwise put the secret straight into the
    // appeal queue and reviewer views.
    const keyed = await app().request(
      post(
        '/v1/appeals',
        {
          action_id: actionId,
          user_statement:
            'my seed is abandon ability able about above absent absorb abstract absurd abuse access accident',
        },
        AUTHOR_COOKIE,
      ),
    );
    expect(keyed.status).toBe(422);
    expect(((await keyed.json()) as { error: { code: string } }).error.code).toBe(
      'key_material_blocked',
    );
    // …and the blocked appeal was DISCARDED, so the real one still goes through.
    // First appeal succeeds; the duplicate is 409.
    expect(
      (
        await app().request(
          post('/v1/appeals', { action_id: actionId, user_statement: 'x' }, AUTHOR_COOKIE),
        )
      ).status,
    ).toBe(201);
    const dup = await app().request(
      post('/v1/appeals', { action_id: actionId, user_statement: 'again' }, AUTHOR_COOKIE),
    );
    expect(dup.status).toBe(409);
    // Appealing a non-existent action → 404.
    expect(
      (
        await app().request(
          post('/v1/appeals', { action_id: randomUUID(), user_statement: 'x' }, AUTHOR_COOKIE),
        )
      ).status,
    ).toBe(404);
    // A CSAM removal is non-appealable → 403.
    const csam = await app().request(
      post(
        '/v1/moderation/actions',
        {
          target_type: 'content',
          target_id: randomUUID(),
          action: 'remove',
          reason_code: 'MOD_CSE_001',
        },
        safety.cookie,
      ),
    );
    const csamActionId = ((await csam.json()) as { action_id: string }).action_id;
    const csamAppeal = await app().request(
      post('/v1/appeals', { action_id: csamActionId, user_statement: 'x' }, AUTHOR_COOKIE),
    );
    expect(csamAppeal.status).toBe(403);
  });

  it('marks a notice read (and 404s an unknown notice)', async () => {
    const safety = await seedUser({
      handle: `saf${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_SAFETY'],
    });
    await app().request(
      post(
        '/v1/moderation/actions',
        {
          target_type: 'content',
          target_id: randomUUID(),
          action: 'warn',
          reason_code: 'MOD_HARASS_001',
        },
        safety.cookie,
      ),
    );
    const inbox = await app().request(get('/v1/moderation/notices', AUTHOR_COOKIE));
    const noticeId = ((await inbox.json()) as { notices: Array<{ notice_id?: string }> }).notices[0]
      ?.notice_id;
    if (noticeId) {
      expect(
        (await app().request(post(`/v1/moderation/notices/${noticeId}/read`, {}, AUTHOR_COOKIE)))
          .status,
      ).toBe(200);
    }
    expect(
      (await app().request(post(`/v1/moderation/notices/${randomUUID()}/read`, {}, AUTHOR_COOKIE)))
        .status,
    ).toBe(404);
  });

  it('#12 rejects a room report for a nonexistent room (404)', async () => {
    const reporter = await seedUser({ handle: `rr${randomUUID().slice(0, 6)}` });
    const res = await app().request(
      post(
        '/v1/reports',
        reportBody({ target_type: 'room', target_id: randomUUID(), content_kind: undefined }),
        reporter.cookie,
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('console route branches (assign, bulk, revert, reviewer-status, queue filters)', () => {
  async function safetyUser() {
    return seedUser({
      handle: `saf${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'steward'],
      stewardRoles: ['ROLE_SAFETY'],
    });
  }
  async function openCase(): Promise<string> {
    const reporter = await seedUser({ handle: `rep${randomUUID().slice(0, 6)}` });
    await app().request(post('/v1/reports', reportBody(), reporter.cookie));
    const mod = getModerationServices();
    const cases = await mod.cases.list({ limit: 1 });
    return cases[0]?.caseId ?? '';
  }

  it('assigns a case (ok / case-404 / reviewer-404 / reviewer-ineligible)', async () => {
    const safety = await safetyUser();
    const caseId = await openCase();
    const otherSafety = await safetyUser();
    const okRes = await app().request(
      post(
        `/v1/moderation/cases/${caseId}/assign`,
        { reviewer_id: otherSafety.userId },
        safety.cookie,
      ),
    );
    expect(okRes.status).toBe(200);
    expect(
      (
        await app().request(
          post(
            `/v1/moderation/cases/${randomUUID()}/assign`,
            { reviewer_id: otherSafety.userId },
            safety.cookie,
          ),
        )
      ).status,
    ).toBe(404); // case not found
    expect(
      (
        await app().request(
          post(
            `/v1/moderation/cases/${caseId}/assign`,
            { reviewer_id: randomUUID() },
            safety.cookie,
          ),
        )
      ).status,
    ).toBe(404); // reviewer not found
    const evidence = await seedUser({
      handle: `ev${randomUUID().slice(0, 6)}`,
      stewardRoles: ['ROLE_EVIDENCE'],
    });
    expect(
      (
        await app().request(
          post(
            `/v1/moderation/cases/${caseId}/assign`,
            { reviewer_id: evidence.userId },
            safety.cookie,
          ),
        )
      ).status,
    ).toBe(400); // reviewer cannot access the report queue
  });

  it('bulk dismiss + assign + per-item errors + bulk_too_large', async () => {
    const admin = await seedUser({
      handle: `adm${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'admin'],
    });
    const c1 = await openCase();
    const c2 = await openCase();
    const dismiss = await app().request(
      post(
        '/v1/moderation/bulk',
        { case_ids: [c1, c2], action: 'dismiss', reason_code: 'MOD_SPAM_001' },
        admin.cookie,
      ),
    );
    expect(dismiss.status).toBe(200);
    expect(
      ((await dismiss.json()) as { results: Array<{ ok: boolean }> }).results.every((r) => r.ok),
    ).toBe(true);
    // assign without reviewer_id → per-item reviewer_required; missing case → not_found.
    const c3 = await openCase();
    const mixed = await app().request(
      post(
        '/v1/moderation/bulk',
        { case_ids: [c3, randomUUID()], action: 'assign', reason_code: 'MOD_SPAM_001' },
        admin.cookie,
      ),
    );
    const results = (
      (await mixed.json()) as { results: Array<{ ok: boolean; error: string | null }> }
    ).results;
    expect(results.some((r) => r.error === 'reviewer_required')).toBe(true);
    expect(results.some((r) => r.error === 'not_found')).toBe(true);
    // bulk_too_large.
    await app().request(
      new Request('http://localhost/v1/moderation/config', {
        method: 'PATCH',
        headers: json(admin.cookie),
        body: JSON.stringify({ bulkActionMax: 1 }),
      }),
    );
    const tooLarge = await app().request(
      post(
        '/v1/moderation/bulk',
        { case_ids: [c1, c2], action: 'dismiss', reason_code: 'MOD_SPAM_001' },
        admin.cookie,
      ),
    );
    expect(tooLarge.status).toBe(400);
  });

  it('reverts a reversible action and 404s/409s the edge cases', async () => {
    const safety = await safetyUser();
    const hide = await app().request(
      post(
        '/v1/moderation/actions',
        {
          target_type: 'content',
          target_id: randomUUID(),
          action: 'hide',
          reason_code: 'MOD_HARASS_001',
        },
        safety.cookie,
      ),
    );
    const actionId = ((await hide.json()) as { action_id: string }).action_id;
    const reverted = await app().request(
      post(
        `/v1/moderation/actions/${actionId}/revert`,
        { reason_code: 'MOD_HARASS_001' },
        safety.cookie,
      ),
    );
    expect(reverted.status).toBe(200);
    expect(
      (
        await app().request(
          post(
            `/v1/moderation/actions/${randomUUID()}/revert`,
            { reason_code: 'MOD_HARASS_001' },
            safety.cookie,
          ),
        )
      ).status,
    ).toBe(404);
    // A permanent ban is not revertible (409).
    const admin = await seedUser({
      handle: `adm${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'admin'],
    });
    const ban = await app().request(
      post(
        '/v1/moderation/actions',
        { target_type: 'account', target_id: AUTHOR, action: 'ban', reason_code: 'MOD_HARASS_002' },
        admin.cookie,
      ),
    );
    const banId = ((await ban.json()) as { action_id: string }).action_id;
    expect(
      (
        await app().request(
          post(
            `/v1/moderation/actions/${banId}/revert`,
            { reason_code: 'MOD_HARASS_002' },
            admin.cookie,
          ),
        )
      ).status,
    ).toBe(409);
  });

  it('sets reviewer availability and applies queue filters', async () => {
    const safety = await safetyUser();
    expect(
      (
        await app().request(
          post('/v1/moderation/reviewer-status', { status: 'available' }, safety.cookie),
        )
      ).status,
    ).toBe(200);
    await openCase();
    // severity/status are array-valued (combinable filters); the scalar query
    // params (assignment + limit) exercise the route's filter-mapping branches.
    const filtered = await app().request(
      get('/v1/moderation/queue?assignment=unassigned&limit=5', safety.cookie),
    );
    expect(filtered.status).toBe(200);
  });

  it('paginates the audit log with a cursor', async () => {
    const admin = await seedUser({
      handle: `adm${randomUUID().slice(0, 6)}`,
      platformRoles: ['user', 'admin'],
    });
    for (let i = 0; i < 2; i += 1) {
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
    }
    const page1 = await app().request(
      get('/v1/moderation/audit?action=hide&limit=1', admin.cookie),
    );
    const body1 = (await page1.json()) as { items: unknown[]; next_cursor: string | null };
    expect(body1.items.length).toBe(1);
    expect(body1.next_cursor).not.toBeNull();
    const page2 = await app().request(
      get(`/v1/moderation/audit?action=hide&limit=1&cursor=${body1.next_cursor}`, admin.cookie),
    );
    expect(((await page2.json()) as { items: unknown[] }).items.length).toBe(1);
  });

  it('#18 reviewer availability is gated to report/appeal reviewers', async () => {
    // An evidence-only steward (no report/appeal queue) cannot enter the pool.
    const evidence = await seedUser({
      handle: `ev${randomUUID().slice(0, 6)}`,
      stewardRoles: ['ROLE_EVIDENCE'],
    });
    expect(
      (
        await app().request(
          post('/v1/moderation/reviewer-status', { status: 'available' }, evidence.cookie),
        )
      ).status,
    ).toBe(403);
    // A report-queue steward can.
    const safety = await safetyUser();
    expect(
      (
        await app().request(
          post('/v1/moderation/reviewer-status', { status: 'available' }, safety.cookie),
        )
      ).status,
    ).toBe(200);
  });

  it('#6 bulk is gated by report-queue access + assignee eligibility', async () => {
    const safety = await safetyUser();
    const c1 = await openCase();
    // An evidence-only steward holds a doctrine role but NOT report-queue access
    // → the whole bulk request is 403 (matching the single-case routes).
    const evidence = await seedUser({
      handle: `ev${randomUUID().slice(0, 6)}`,
      stewardRoles: ['ROLE_EVIDENCE'],
    });
    const denied = await app().request(
      post(
        '/v1/moderation/bulk',
        { case_ids: [c1], action: 'dismiss', reason_code: 'MOD_SPAM_001' },
        evidence.cookie,
      ),
    );
    expect(denied.status).toBe(403);
    // A report-queue steward assigning to an INELIGIBLE (evidence-only) reviewer
    // → 400 (the assignee cannot access the report queue).
    const ineligible = await app().request(
      post(
        '/v1/moderation/bulk',
        {
          case_ids: [c1],
          action: 'assign',
          reason_code: 'MOD_SPAM_001',
          reviewer_id: evidence.userId,
        },
        safety.cookie,
      ),
    );
    expect(ineligible.status).toBe(400);
  });
});
