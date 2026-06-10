// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S3-compatible ObjectStore for DSAR export archives (WS-D.2.2c) — the
// production binding behind the same interface as InMemoryObjectStore.  Works
// against AWS S3, Cloudflare R2, and MinIO (path-style addressing, SigV4 over
// fetch — no AWS SDK; see sigv4.ts).
//
// Security properties, matching the in-memory adapter:
//   • The object body is the SecretBox-SEALED archive (AES-256-GCM under an
//     HKDF-derived key) — a bucket leak yields ciphertext.  Server-side
//     encryption (SSE-KMS) is recommended on the bucket as defense in depth,
//     but confidentiality never depends on it.
//   • The expiry instant rides in object metadata and is enforced AT READ
//     TIME (an expired object reads as null and is deleted), so the 72-hour
//     bound holds even between sweeper ticks.  A bucket lifecycle rule is a
//     further backstop.
//   • expiredKeys lists the prefix and HEADs each object's expiry — export
//     volume is small (a user's archives within a 72-hour window), so the
//     sweep stays O(objects), not O(history).
import type { ServerEnv } from '@licio/shared/env';
import { sha256Hex } from './crypto.js';
import type { ObjectStore } from './object-store.js';
import type { SecretBox } from './secrets.js';
import { type SigV4Credentials, signRequest, uriEncode } from './sigv4.js';

export interface S3ObjectStoreConfig {
  /** e.g. https://s3.us-east-1.amazonaws.com or http://localhost:9000 (MinIO). */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket (namespacing), e.g. 'licio/'. */
  prefix?: string;
}

/**
 * Derive the S3 config from the validated server env.  The group is
 * all-or-none (enforced by the env schema): null means "not configured" and
 * the caller falls back to the in-memory store.
 */
export function s3ConfigFromEnv(
  env: Pick<
    ServerEnv,
    | 'S3_ENDPOINT'
    | 'S3_REGION'
    | 'S3_BUCKET'
    | 'S3_ACCESS_KEY_ID'
    | 'S3_SECRET_ACCESS_KEY'
    | 'S3_PREFIX'
  >,
): S3ObjectStoreConfig | null {
  if (
    !env.S3_ENDPOINT ||
    !env.S3_REGION ||
    !env.S3_BUCKET ||
    !env.S3_ACCESS_KEY_ID ||
    !env.S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    ...(env.S3_PREFIX ? { prefix: env.S3_PREFIX } : {}),
  };
}

const META_EXPIRES = 'x-amz-meta-licio-expires-at';
const META_CONTENT_TYPE = 'x-amz-meta-licio-content-type';

export class S3ObjectStore implements ObjectStore {
  readonly #box: SecretBox;
  readonly #cfg: S3ObjectStoreConfig;
  readonly #creds: SigV4Credentials;
  readonly #fetch: typeof fetch;

  constructor(box: SecretBox, cfg: S3ObjectStoreConfig, fetchFn: typeof fetch = fetch) {
    this.#box = box;
    this.#cfg = cfg;
    this.#creds = {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: 's3',
    };
    this.#fetch = fetchFn;
  }

  #objectKey(key: string): string {
    return `${this.#cfg.prefix ?? ''}${key}`;
  }

  #objectUrl(key: string): URL {
    return new URL(
      `/${this.#cfg.bucket}/${uriEncode(this.#objectKey(key), false)}`,
      this.#cfg.endpoint,
    );
  }

  #bucketUrl(query: Record<string, string>): URL {
    const url = new URL(`/${this.#cfg.bucket}`, this.#cfg.endpoint);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  async #request(
    method: string,
    url: URL,
    opts: { body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const payloadHash = sha256Hex(opts.body ?? Buffer.alloc(0));
    const headers = signRequest(
      {
        method,
        url,
        headers: { ...opts.headers, 'x-amz-content-sha256': payloadHash },
        payloadHash,
      },
      this.#creds,
    );
    return this.#fetch(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: new Uint8Array(opts.body) } : {}),
    });
  }

  async put(key: string, plaintext: string, contentType: string, expiresAt: number): Promise<void> {
    const sealed = Buffer.from(this.#box.seal(plaintext), 'utf8');
    const res = await this.#request('PUT', this.#objectUrl(key), {
      body: sealed,
      headers: {
        'content-type': 'application/octet-stream', // the body is ciphertext
        [META_CONTENT_TYPE]: contentType,
        [META_EXPIRES]: String(expiresAt),
      },
    });
    if (!res.ok) throw new Error(`S3 put failed: ${res.status}`);
  }

  async get(
    key: string,
    now: number = Date.now(),
  ): Promise<{ bytes: Buffer; contentType: string } | null> {
    const res = await this.#request('GET', this.#objectUrl(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 get failed: ${res.status}`);
    const expiresAt = Number(res.headers.get(META_EXPIRES) ?? Number.NaN);
    // Read-time expiry enforcement: a missing/garbled expiry is treated as
    // expired (fail closed), mirroring the in-memory adapter's behaviour.
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      await this.delete(key);
      return null;
    }
    return {
      bytes: this.#box.open(await res.text()),
      contentType: res.headers.get(META_CONTENT_TYPE) ?? 'application/json',
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.#request('DELETE', this.#objectUrl(key));
    // 404 is success for an idempotent delete.
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: ${res.status}`);
  }

  async expiredKeys(now: number): Promise<string[]> {
    const expired: string[] = [];
    for (const key of await this.#listKeys()) {
      const head = await this.#request('HEAD', this.#objectUrl(key));
      if (head.status === 404) continue; // deleted between LIST and HEAD
      if (!head.ok) throw new Error(`S3 head failed: ${head.status}`);
      const expiresAt = Number(head.headers.get(META_EXPIRES) ?? Number.NaN);
      // No/garbled expiry metadata ⇒ treat as expired so the sweeper removes
      // it (fail closed — nothing lingers in the bucket unbounded).
      if (!Number.isFinite(expiresAt) || expiresAt <= now) expired.push(key);
    }
    return expired;
  }

  async clear(): Promise<void> {
    for (const key of await this.#listKeys()) await this.delete(key);
  }

  /** All LOGICAL keys under the configured prefix (paginated ListObjectsV2). */
  async #listKeys(): Promise<string[]> {
    const prefix = this.#cfg.prefix ?? '';
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.#request(
        'GET',
        this.#bucketUrl({
          'list-type': '2',
          ...(prefix ? { prefix } : {}),
          ...(continuationToken ? { 'continuation-token': continuationToken } : {}),
        }),
      );
      if (!res.ok) throw new Error(`S3 list failed: ${res.status}`);
      const xml = await res.text();
      // Our object keys are self-generated ([A-Za-z0-9/_-]); none need XML
      // unescaping, so tag extraction is sufficient and dependency-free.
      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        const objectKey = match[1] ?? '';
        keys.push(objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : objectKey);
      }
      const token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      continuationToken = truncated && token?.[1] ? token[1] : undefined;
    } while (continuationToken);
    return keys;
  }
}
