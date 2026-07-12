// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STEWARD_ROLES.md ROLE_EVIDENCE surface (SPEC §16.3): the evidence queue
// (derived from citation-bearing published contributions), the two doctrine
// actions (`mark-primary-source` / `flag-citation`) + the `clear` workflow,
// their authorization matrix, the audit trail, the widened url-verdict gate,
// and the public primary-source read the independent-sources drawer consumes.
import { randomUUID } from 'node:crypto';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  evidenceDecisionsResponseSchema,
  evidenceQueueResponseSchema,
  type StewardRoleId,
} from '@licio/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '../identity/rbac.js';
import type { IdentityServices } from '../identity/services.js';
import { buildSessionCookie, createSession } from '../identity/sessions.js';
import { primarySourcesForStory } from '../moderation/evidence.js';
import type { CitedContribution, ModerationContentPort } from '../moderation/ports.js';
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

/** The mutable cited-contribution fixture the content port serves. */
let cited: CitedContribution[] = [];

const STORY = randomUUID();
const THREAD = randomUUID();

function citedFixture(n: number): CitedContribution {
  return {
    contributionId: randomUUID(),
    threadId: THREAD,
    storyId: STORY,
    storyTitle: 'Hospital readmission data released',
    type: 'comment',
    bodyPreview: `Sourced comment ${n}`,
    citations: [
      { url: `https://example.org/source-${n}`, title: `Source ${n}` },
      { url: `doi:10.1000/demo.${n}` },
    ],
    createdAt: new Date(1_700_000_000_000 + n * 60_000).toISOString(),
  };
}

function evidenceContentPort(): ModerationContentPort {
  return {
    async resolveTarget() {
      return { exists: true, subjectUserId: null, contentKind: 'contribution' };
    },
    async applyContentState() {},
    async applyAccountState() {},
    async contentSnapshot() {
      return null;
    },
    async threadContext() {
      return { items: [], reportedContributionId: null };
    },
    async listCitedContributions({ after, limit }) {
      const sorted = [...cited].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.contributionId.localeCompare(b.contributionId),
      );
      const filtered = after
        ? sorted.filter(
            (c) =>
              c.createdAt > after.createdAt ||
              (c.createdAt === after.createdAt && c.contributionId > after.id),
          )
        : sorted;
      return filtered.slice(0, limit);
    },
    async getCitedContribution(contributionId) {
      return cited.find((c) => c.contributionId === contributionId) ?? null;
    },
  };
}

async function seedUser(opts: {
  handle: string;
  platformRoles?: Role[];
  stewardRoles?: StewardRoleId[];
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
  const isSteward =
    (opts.stewardRoles?.length ?? 0) > 0 || (opts.platformRoles ?? []).includes('admin');
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

const get = (path: string, cookie: string) =>
  new Request(`http://localhost${path}`, { headers: { cookie } });
const post = (path: string, body: unknown, cookie: string) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

let evidenceSteward: { userId: string; cookie: string };
let safetySteward: { userId: string; cookie: string };

beforeEach(async () => {
  ({ identity } = freshEventServices());
  cited = [citedFixture(1), citedFixture(2), citedFixture(3)];
  setModerationServices(
    createInMemoryModerationServices({
      content: evidenceContentPort(),
      users: {
        async resolve(id) {
          const u = await identity.store.getUser(id);
          return u
            ? {
                handle: u.handle,
                accountAgeDays: 1,
                contributionCount: 0,
                contributionTypes: {},
                roomsActiveIn: 0,
              }
            : null;
        },
        async resolveMany(ids) {
          const out = new Map();
          for (const id of ids) {
            const u = await identity.store.getUser(id);
            if (u)
              out.set(id, {
                handle: u.handle,
                accountAgeDays: 1,
                contributionCount: 0,
                contributionTypes: {},
                roomsActiveIn: 0,
              });
          }
          return out;
        },
        async currentAccountState() {
          return null;
        },
      },
    }),
  );
  evidenceSteward = await seedUser({
    handle: `evid${randomUUID().slice(0, 6)}`,
    stewardRoles: ['ROLE_EVIDENCE'],
  });
  safetySteward = await seedUser({
    handle: `safe${randomUUID().slice(0, 6)}`,
    stewardRoles: ['ROLE_SAFETY'],
  });
});
afterEach(() => {
  resetModerationServicesForTests();
});

describe('GET /v1/moderation/evidence-queue (ROLE_EVIDENCE)', () => {
  it('403s a steward without evidence-queue access', async () => {
    const res = await app().fetch(get('/v1/moderation/evidence-queue', safetySteward.cookie));
    expect(res.status).toBe(403);
  });

  it('lists citation-bearing contributions FIFO for an evidence steward', async () => {
    const res = await app().fetch(get('/v1/moderation/evidence-queue', evidenceSteward.cookie));
    expect(res.status).toBe(200);
    const body = evidenceQueueResponseSchema.parse(await res.json());
    expect(body.items.map((i) => i.body_preview)).toEqual([
      'Sourced comment 1',
      'Sourced comment 2',
      'Sourced comment 3',
    ]);
    expect(body.items[0]?.story_title).toBe('Hospital readmission data released');
    expect(body.items[0]?.citations.length).toBe(2);
  });

  it('admin implicitly holds the queue; decided rows leave it', async () => {
    const admin = await seedUser({
      handle: `admin${randomUUID().slice(0, 6)}`,
      platformRoles: ['admin'],
    });
    const target = cited[0];
    if (!target) throw new Error('fixture missing');
    const decide = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        { contribution_id: target.contributionId, action: 'clear' },
        admin.cookie,
      ),
    );
    expect(decide.status).toBe(201);
    const res = await app().fetch(get('/v1/moderation/evidence-queue', admin.cookie));
    const body = evidenceQueueResponseSchema.parse(await res.json());
    expect(body.items.map((i) => i.contribution_id)).not.toContain(target.contributionId);
    expect(body.items).toHaveLength(2);
  });

  it('paginates with a cursor that advances over rows decided between pages', async () => {
    const first = await app().fetch(
      get('/v1/moderation/evidence-queue?limit=2', evidenceSteward.cookie),
    );
    const page1 = evidenceQueueResponseSchema.parse(await first.json());
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();
    // Decide BOTH page-1 rows (including the page-boundary row the cursor
    // encodes) BETWEEN the page reads — the cursor must still advance to the
    // undecided remainder without skipping it.
    for (const item of page1.items) {
      const decided = await getModerationServices().evidenceDecisions.insert({
        contributionId: item.contribution_id,
        threadId: item.thread_id,
        storyId: item.story_id,
        action: 'clear',
        citationUrl: null,
        citationTitle: null,
        reasonCode: null,
        note: null,
        decidedBy: evidenceSteward.userId,
      });
      expect(decided.ok).toBe(true);
    }
    const second = await app().fetch(
      get(
        `/v1/moderation/evidence-queue?limit=2&cursor=${page1.next_cursor}`,
        evidenceSteward.cookie,
      ),
    );
    const page2 = evidenceQueueResponseSchema.parse(await second.json());
    expect(page2.items.map((i) => i.body_preview)).toEqual(['Sourced comment 3']);
  });

  it('a fully-decided first scan batch still yields the later undecided row', async () => {
    // 30 candidates; the queue scans internal batches of ≥25 — decide the whole
    // first batch (and the first row of the second) so page 1 must advance
    // across an entirely-decided batch to reach fixture 27.
    cited = Array.from({ length: 30 }, (_, i) => citedFixture(i + 1));
    const mod = getModerationServices();
    for (const candidate of cited.slice(0, 26)) {
      const decided = await mod.evidenceDecisions.insert({
        contributionId: candidate.contributionId,
        threadId: candidate.threadId,
        storyId: candidate.storyId,
        action: 'clear',
        citationUrl: null,
        citationTitle: null,
        reasonCode: null,
        note: null,
        decidedBy: evidenceSteward.userId,
      });
      expect(decided.ok).toBe(true);
    }
    const res = await app().fetch(
      get('/v1/moderation/evidence-queue?limit=1', evidenceSteward.cookie),
    );
    expect(res.status).toBe(200);
    const body = evidenceQueueResponseSchema.parse(await res.json());
    expect(body.items.map((i) => i.body_preview)).toEqual(['Sourced comment 27']);
  });

  it('a malformed cursor restarts from page 1 instead of erroring', async () => {
    for (const cursor of [
      'garbage', // not a decodable createdAt|id pair at all
      Buffer.from('not-a-timestamp|not-a-uuid', 'utf-8').toString('base64url'),
      Buffer.from('2026-01-01T00:00:00.000Z|not-a-uuid', 'utf-8').toString('base64url'),
    ]) {
      const res = await app().fetch(
        get(`/v1/moderation/evidence-queue?cursor=${cursor}`, evidenceSteward.cookie),
      );
      expect(res.status).toBe(200); // restart-from-beginning, never a 500
      const body = evidenceQueueResponseSchema.parse(await res.json());
      expect(body.items.map((i) => i.body_preview)).toEqual([
        'Sourced comment 1',
        'Sourced comment 2',
        'Sourced comment 3',
      ]);
    }
  });
});

describe('POST /v1/moderation/evidence-decisions', () => {
  it('mark-primary-source: 201, records the decision, audits under the doctrine id', async () => {
    const target = cited[0];
    if (!target) throw new Error('fixture missing');
    const url = target.citations[0]?.url ?? '';
    const res = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: url,
        },
        evidenceSteward.cookie,
      ),
    );
    expect(res.status).toBe(201);
    const view = (await res.json()) as { action: string; citation_url: string };
    expect(view.action).toBe('mark-primary-source');
    expect(view.citation_url).toBe(url);
    const mod = getModerationServices();
    const audits = await mod.audit.list({ action: 'mark-primary-source', limit: 10 });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorRole).toBe('ROLE_EVIDENCE');
    expect(audits[0]?.targetId).toBe(target.contributionId);
  });

  it('flag-citation with a ratified reason code succeeds; without one is rejected', async () => {
    const target = cited[1];
    if (!target) throw new Error('fixture missing');
    const url = target.citations[0]?.url ?? '';
    const missing = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        { contribution_id: target.contributionId, action: 'flag-citation', citation_url: url },
        evidenceSteward.cookie,
      ),
    );
    expect(missing.status).toBe(400);
    const ok = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'flag-citation',
          citation_url: url,
          reason_code: 'MOD_MISINFO_001',
          note: 'Primary claim not supported by the linked page.',
        },
        evidenceSteward.cookie,
      ),
    );
    expect(ok.status).toBe(201);
  });

  it('rejects the doctrine-shaped failure cases', async () => {
    const target = cited[0];
    if (!target) throw new Error('fixture missing');
    const url = target.citations[0]?.url ?? '';
    // A citation action from a steward WITHOUT the capability (ROLE_SAFETY).
    const wrongRole = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: url,
        },
        safetySteward.cookie,
      ),
    );
    expect(wrongRole.status).toBe(403);
    // Unknown contribution.
    const unknown = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        { contribution_id: randomUUID(), action: 'clear' },
        evidenceSteward.cookie,
      ),
    );
    expect(unknown.status).toBe(404);
    // citation_url outside the contribution's own citations.
    const foreign = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: 'https://example.org/not-on-this-contribution',
        },
        evidenceSteward.cookie,
      ),
    );
    expect(foreign.status).toBe(400);
    // clear must not carry a citation target (schema shape).
    const clearWithUrl = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        { contribution_id: target.contributionId, action: 'clear', citation_url: url },
        evidenceSteward.cookie,
      ),
    );
    expect(clearWithUrl.status).toBe(400);
    // Duplicate identical decision → 409.
    const first = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: url,
        },
        evidenceSteward.cookie,
      ),
    );
    expect(first.status).toBe(201);
    const dupe = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: url,
        },
        evidenceSteward.cookie,
      ),
    );
    expect(dupe.status).toBe(409);
  });
});

describe('mark-primary-source malware gate (citation_malicious)', () => {
  it('refuses a known-malicious http(s) citation with 422 citation_malicious', async () => {
    const target = cited[0];
    if (!target) throw new Error('fixture missing');
    getModerationServices().urlVerdict = async () => 'malicious';
    const res = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: target.citations[0]?.url ?? '',
        },
        evidenceSteward.cookie,
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('citation_malicious');
    // Refused ⇒ NOTHING recorded: the contribution is still an open candidate.
    const queue = await app().fetch(get('/v1/moderation/evidence-queue', evidenceSteward.cookie));
    const queueBody = evidenceQueueResponseSchema.parse(await queue.json());
    expect(queueBody.items.map((i) => i.contribution_id)).toContain(target.contributionId);
  });

  it('a doi: citation has no fetchable destination — 201 even under a malicious verdict', async () => {
    const target = cited[0];
    if (!target) throw new Error('fixture missing');
    getModerationServices().urlVerdict = async () => 'malicious';
    const res = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: target.citations[1]?.url ?? '', // doi:10.1000/demo.1
        },
        evidenceSteward.cookie,
      ),
    );
    expect(res.status).toBe(201);
  });

  it("an 'unavailable' verdict proceeds on steward judgment (201)", async () => {
    const target = cited[1];
    if (!target) throw new Error('fixture missing');
    getModerationServices().urlVerdict = async () => 'unavailable';
    const res = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: target.citations[0]?.url ?? '',
        },
        evidenceSteward.cookie,
      ),
    );
    expect(res.status).toBe(201);
  });
});

describe('GET /v1/moderation/evidence-decisions', () => {
  it('lists decisions newest first with the decider handle', async () => {
    const target = cited[0];
    if (!target) throw new Error('fixture missing');
    await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: target.citations[0]?.url ?? '',
        },
        evidenceSteward.cookie,
      ),
    );
    const res = await app().fetch(get('/v1/moderation/evidence-decisions', evidenceSteward.cookie));
    expect(res.status).toBe(200);
    const body = evidenceDecisionsResponseSchema.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.decided_by_handle).toMatch(/^evid/);
    expect(body.items[0]?.story_id).toBe(STORY);
  });

  it('403s a steward without evidence-queue access', async () => {
    const res = await app().fetch(get('/v1/moderation/evidence-decisions', safetySteward.cookie));
    expect(res.status).toBe(403);
  });
});

describe('url-verdict gate widening (citations render in the evidence panel)', () => {
  it('an evidence-only steward gets a verdict instead of 403', async () => {
    const res = await app().fetch(
      post('/v1/moderation/url-verdict', { url: 'https://example.org/x' }, evidenceSteward.cookie),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdict: string };
    // The unwired seam fails toward flagging, never trusting.
    expect(body.verdict).toBe('unavailable');
  });
});

describe('primarySourcesForStory (the independent-sources drawer read)', () => {
  it('returns marked citations deduped by URL with decision-time titles', async () => {
    const target = cited[0];
    const other = cited[1];
    if (!target || !other) throw new Error('fixture missing');
    for (const [contribution, url, title] of [
      [target, target.citations[0]?.url ?? '', 'Source 1'],
      [other, other.citations[0]?.url ?? '', 'Source 2'],
    ] as const) {
      const res = await app().fetch(
        post(
          '/v1/moderation/evidence-decisions',
          {
            contribution_id: contribution.contributionId,
            action: 'mark-primary-source',
            citation_url: url,
          },
          evidenceSteward.cookie,
        ),
      );
      expect(res.status).toBe(201);
      expect(title.length).toBeGreaterThan(0);
    }
    // A flag on the same citation must NOT surface as a primary source.
    await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'flag-citation',
          citation_url: target.citations[1]?.url ?? '',
          reason_code: 'MOD_MISINFO_001',
        },
        evidenceSteward.cookie,
      ),
    );
    const sources = await primarySourcesForStory(getModerationServices(), STORY);
    expect(sources).toHaveLength(2);
    // A mark stops surfacing once its contribution is no longer published
    // (the content port's published-only read returns null for it).
    const removedId = other.contributionId;
    cited = cited.filter((c) => c.contributionId !== removedId);
    const afterRemoval = await primarySourcesForStory(getModerationServices(), STORY);
    expect(afterRemoval.map((s) => s.url)).toEqual([target.citations[0]?.url]);
    cited.push(other);
    expect(new Set(sources.map((s) => s.url))).toEqual(
      new Set([target.citations[0]?.url, other.citations[0]?.url]),
    );
    expect(sources.find((s) => s.url === target.citations[0]?.url)?.title).toBe('Source 1');
    // A different story reads nothing.
    expect(await primarySourcesForStory(getModerationServices(), randomUUID())).toEqual([]);
  });

  it('withdraws a mark when the author edits the marked citation away', async () => {
    const target = cited[0];
    if (!target) throw new Error('fixture missing');
    const markedUrl = target.citations[0]?.url ?? '';
    const res = await app().fetch(
      post(
        '/v1/moderation/evidence-decisions',
        {
          contribution_id: target.contributionId,
          action: 'mark-primary-source',
          citation_url: markedUrl,
        },
        evidenceSteward.cookie,
      ),
    );
    expect(res.status).toBe(201);
    expect(
      (await primarySourcesForStory(getModerationServices(), STORY)).map((s) => s.url),
    ).toEqual([markedUrl]);
    // The author replaces the marked URL but keeps the comment cited: the
    // contribution stays published AND cited, yet the mark must withdraw —
    // the steward reviewed the OLD destination, not the new one.
    target.citations = [{ url: 'https://example.org/replacement' }];
    expect(await primarySourcesForStory(getModerationServices(), STORY)).toEqual([]);
  });
});
