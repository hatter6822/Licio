// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S3ObjectStore behaviour against a faithful in-memory S3 fake (PUT/GET/HEAD/
// DELETE/ListObjectsV2 with pagination), injected through the fetch seam.  The
// signing algorithm itself is pinned to the official AWS vectors in
// sigv4.test.ts; here we assert the ObjectStore CONTRACT (the same one the
// in-memory adapter satisfies) plus the security properties: the stored body
// is ciphertext, expiry is enforced at read time, and every request carries a
// SigV4 authorization with the payload hash bound.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { S3ObjectStore, s3ConfigFromEnv } from '../object-store-s3.js';
import { createLocalSecretBox } from '../secrets.js';

const MASTER = 'test-master-secret-at-least-32-characters-long';

interface FakeObject {
  body: Buffer;
  meta: Record<string, string>;
}

/** A minimal, faithful S3: bucket semantics + request-shape assertions. */
class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: Array<{ method: string; path: string; auth: string | undefined }> = [];
  /** Force ListObjectsV2 pagination with tiny pages. */
  pageSize = 1000;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers as Record<string, string>);
    this.requests.push({
      method,
      path: url.pathname + url.search,
      auth: headers.get('authorization') ?? undefined,
    });

    // Every request must be SigV4-signed with the payload hash bound.
    const auth = headers.get('authorization') ?? '';
    if (
      !/^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/.test(
        auth,
      )
    ) {
      return new Response('bad auth', { status: 403 });
    }
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const declaredHash = headers.get('x-amz-content-sha256');
    if (declaredHash !== createHash('sha256').update(body).digest('hex')) {
      return new Response('payload hash mismatch', { status: 400 });
    }

    const [, bucket, ...keyParts] = url.pathname.split('/');
    if (bucket !== 'licio-exports') return new Response('no bucket', { status: 404 });
    const key = decodeURIComponent(keyParts.join('/'));

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('continuation-token');
      const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = after ? all.indexOf(after) + 1 : 0;
      const page = all.slice(start, start + this.pageSize);
      const truncated = start + this.pageSize < all.length;
      const xml =
        '<?xml version="1.0"?><ListBucketResult>' +
        page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('') +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated
          ? `<NextContinuationToken>${page[page.length - 1]}</NextContinuationToken>`
          : '') +
        '</ListBucketResult>';
      return new Response(xml, { status: 200 });
    }

    const obj = this.objects.get(key);
    switch (method) {
      case 'PUT': {
        const meta: Record<string, string> = {};
        headers.forEach((v, k) => {
          if (k.startsWith('x-amz-meta-')) meta[k] = v;
        });
        this.objects.set(key, { body, meta });
        return new Response(null, { status: 200 });
      }
      case 'GET':
        if (!obj) return new Response('NoSuchKey', { status: 404 });
        return new Response(new Uint8Array(obj.body), { status: 200, headers: obj.meta });
      case 'HEAD':
        if (!obj) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: obj.meta });
      case 'DELETE':
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return new Response('unsupported', { status: 405 });
    }
  };
}

const CONFIG = {
  endpoint: 'https://s3.example.test',
  region: 'eu-central-1',
  bucket: 'licio-exports',
  accessKeyId: 'test-access',
  secretAccessKey: 'test-secret',
  prefix: 'dsar/',
};

let fake: FakeS3;
let store: S3ObjectStore;

beforeEach(() => {
  fake = new FakeS3();
  store = new S3ObjectStore(createLocalSecretBox(MASTER), CONFIG, fake.fetch);
});

describe('S3ObjectStore', () => {
  it('round-trips an object and stores ONLY ciphertext in the bucket', async () => {
    const plaintext = JSON.stringify({ secret: 'dsar-archive-contents' });
    await store.put('export/job-1', plaintext, 'application/json', Date.now() + 60_000);

    const raw = fake.objects.get('dsar/export/job-1');
    expect(raw).toBeDefined();
    const atRest = raw?.body.toString('utf8') ?? '';
    expect(atRest).not.toContain('dsar-archive-contents'); // sealed, never plaintext
    expect(atRest.startsWith('v1.')).toBe(true);

    const got = await store.get('export/job-1');
    expect(got?.bytes.toString('utf8')).toBe(plaintext);
    expect(got?.contentType).toBe('application/json');
  });

  it('returns null for a missing object and surfaces non-404 failures', async () => {
    expect(await store.get('export/absent')).toBeNull();
    const broken = new S3ObjectStore(
      createLocalSecretBox(MASTER),
      { ...CONFIG, bucket: 'wrong-bucket' },
      fake.fetch,
    );
    await expect(broken.put('k', 'v', 'text/plain', 1)).rejects.toThrow('S3 put failed');
  });

  it('enforces expiry at READ time: expired object reads null and is deleted', async () => {
    const now = Date.now();
    await store.put('export/old', '{"a":1}', 'application/json', now + 1000);
    expect(await store.get('export/old', now + 999)).not.toBeNull();
    expect(await store.get('export/old', now + 1000)).toBeNull();
    expect(fake.objects.has('dsar/export/old')).toBe(false); // removed on expired read
  });

  it('treats missing expiry metadata as expired (fail closed)', async () => {
    fake.objects.set('dsar/export/legacy', { body: Buffer.from('v1.zz'), meta: {} });
    expect(await store.get('export/legacy')).toBeNull();
    expect(fake.objects.has('dsar/export/legacy')).toBe(false);
  });

  it('sweeps expired keys via paginated LIST + HEAD, returning logical keys', async () => {
    fake.pageSize = 2; // force pagination across 3 pages
    const now = Date.now();
    await store.put('export/a', '{}', 'application/json', now - 2);
    await store.put('export/b', '{}', 'application/json', now + 60_000);
    await store.put('export/c', '{}', 'application/json', now - 1);
    await store.put('export/d', '{}', 'application/json', now);
    await store.put('export/e', '{}', 'application/json', now + 60_000);

    const expired = await store.expiredKeys(now);
    expect(expired.sort()).toEqual(['export/a', 'export/c', 'export/d']);
    // Logical keys (prefix stripped) — the sweeper deletes by the same keys.
    for (const key of expired) await store.delete(key);
    expect([...fake.objects.keys()].sort()).toEqual(['dsar/export/b', 'dsar/export/e']);
  });

  it('delete is idempotent (404 is success); clear empties the prefix', async () => {
    await expect(store.delete('export/never-existed')).resolves.toBeUndefined();
    await store.put('export/x', '{}', 'application/json', Date.now() + 1000);
    await store.put('export/y', '{}', 'application/json', Date.now() + 1000);
    await store.clear();
    expect(fake.objects.size).toBe(0);
  });

  it('signs every request and binds the payload hash (FakeS3 verifies both)', async () => {
    await store.put('export/signed', '{"v":1}', 'application/json', Date.now() + 1000);
    await store.get('export/signed');
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    for (const req of fake.requests) {
      expect(req.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access\//);
    }
  });
});

describe('s3ConfigFromEnv', () => {
  const FULL = {
    S3_ENDPOINT: 'https://s3.example.test',
    S3_REGION: 'eu-central-1',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    S3_PREFIX: undefined,
  };

  it('returns the config when the group is complete, null when absent', () => {
    expect(s3ConfigFromEnv(FULL)).toMatchObject({ bucket: 'b', region: 'eu-central-1' });
    expect(
      s3ConfigFromEnv({
        S3_ENDPOINT: undefined,
        S3_REGION: undefined,
        S3_BUCKET: undefined,
        S3_ACCESS_KEY_ID: undefined,
        S3_SECRET_ACCESS_KEY: undefined,
        S3_PREFIX: undefined,
      }),
    ).toBeNull();
  });

  it('carries the optional prefix through', () => {
    expect(s3ConfigFromEnv({ ...FULL, S3_PREFIX: 'licio/' })?.prefix).toBe('licio/');
  });
});
