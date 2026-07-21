// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The HuggingFace model-hub client (WS-U model candidacy): metadata-only,
// fixed-host, typed-error, TTL-cached. Every failure class maps to a
// ModelHubError code the propose route / GovernanceService translate; gated
// and private models are never selectable candidates regardless of any token.
import { describe, expect, it } from 'vitest';
import {
  HttpModelHubClient,
  type HubFetchLike,
  ModelHubError,
} from '../ai-governance/model-hub.js';

const SHA = 'a'.repeat(40);

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(respond: (url: string) => { status: number; body: unknown } | 'reject'): {
  fetchImpl: HubFetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: HubFetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const outcome = respond(url);
    if (outcome === 'reject') throw new Error('network down');
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      json: async () => outcome.body,
    };
  };
  return { fetchImpl, calls };
}

const MODEL_ITEM = {
  id: 'Qwen/Qwen3Guard-Gen-4B',
  sha: SHA,
  pipeline_tag: 'text-generation',
  gated: false,
  private: false,
  tags: ['license:apache-2.0', 'safetensors'],
  safetensors: { total: 4_400_000_000 },
};

describe('HttpModelHubClient.search', () => {
  it('returns text-capable public candidates and flags gated rows', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: [
        MODEL_ITEM,
        { id: 'org/vision-only', pipeline_tag: 'image-classification' },
        { id: 'org/private-model', pipeline_tag: 'text-generation', private: true },
        { id: 'org/gated-model', pipeline_tag: 'image-text-to-text', gated: 'manual' },
        { id: 'not-a-repo-id', pipeline_tag: 'text-generation' },
      ],
    }));
    const client = new HttpModelHubClient({ fetchImpl });
    const results = await client.search('qwen guard');
    expect(results).toEqual([
      {
        repo_id: 'Qwen/Qwen3Guard-Gen-4B',
        pipeline_tag: 'text-generation',
        license: 'apache-2.0',
        gated: false,
      },
      {
        repo_id: 'org/gated-model',
        pipeline_tag: 'image-text-to-text',
        license: null,
        gated: true,
      },
    ]);
  });

  it('short queries return [] without any egress; transport faults are typed', async () => {
    const { fetchImpl, calls } = fakeFetch(() => 'reject');
    const client = new HttpModelHubClient({ fetchImpl });
    expect(await client.search(' a ')).toEqual([]);
    expect(calls).toHaveLength(0);
    await expect(client.search('qwen')).rejects.toMatchObject({ code: 'transport' });
  });

  it('sends the token as a bearer header when configured (never without one)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    await new HttpModelHubClient({ fetchImpl, token: 'hf_test' }).search('qwen');
    expect(calls[0]?.headers['authorization']).toBe('Bearer hf_test');
    const bare = fakeFetch(() => ({ status: 200, body: [] }));
    await new HttpModelHubClient({ fetchImpl: bare.fetchImpl }).search('qwen');
    expect(bare.calls[0]?.headers['authorization']).toBeUndefined();
  });
});

describe('HttpModelHubClient.resolve (head-revision pinning)', () => {
  it('pins the head sha with the candidacy metadata', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: MODEL_ITEM }));
    const client = new HttpModelHubClient({ fetchImpl, now: () => 0 });
    const metadata = await client.resolve('Qwen/Qwen3Guard-Gen-4B');
    expect(metadata).toMatchObject({
      repo_id: 'Qwen/Qwen3Guard-Gen-4B',
      revision: SHA,
      pipeline_tag: 'text-generation',
      license: 'apache-2.0',
      parameter_count: 4_400_000_000,
    });
    expect(calls[0]?.url).toBe('https://huggingface.co/api/models/Qwen/Qwen3Guard-Gen-4B');
  });

  it('refuses a repo without a resolvable head sha, a bad repo id, and gated/private repos', async () => {
    const noSha = fakeFetch(() => ({ status: 200, body: { ...MODEL_ITEM, sha: undefined } }));
    await expect(
      new HttpModelHubClient({ fetchImpl: noSha.fetchImpl }).resolve('Qwen/Qwen3Guard-Gen-4B'),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    const ok = fakeFetch(() => ({ status: 200, body: MODEL_ITEM }));
    await expect(
      new HttpModelHubClient({ fetchImpl: ok.fetchImpl }).resolve('../../etc/passwd'),
    ).rejects.toThrow(); // zod repo-id guard before any URL is built
    expect(ok.calls).toHaveLength(0);
    const gated = fakeFetch(() => ({ status: 200, body: { ...MODEL_ITEM, gated: 'auto' } }));
    await expect(
      new HttpModelHubClient({ fetchImpl: gated.fetchImpl }).resolve('Qwen/Qwen3Guard-Gen-4B'),
    ).rejects.toMatchObject({ code: 'gated' });
  });
});

describe('HttpModelHubClient.verify (pinned-revision candidacy)', () => {
  const REF = { source: 'huggingface', repoId: 'Qwen/Qwen3.6-27B', revision: SHA } as const;

  it('verifies a public text-capable model at its pin', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { ...MODEL_ITEM, id: 'Qwen/Qwen3.6-27B', pipeline_tag: 'image-text-to-text' },
    }));
    const metadata = await new HttpModelHubClient({ fetchImpl }).verify(REF);
    expect(metadata.revision).toBe(SHA);
    expect(calls[0]?.url).toBe(
      `https://huggingface.co/api/models/Qwen/Qwen3.6-27B/revision/${SHA}`,
    );
  });

  it('maps 401/403/404 to not_found (missing and private look identical unauthenticated)', async () => {
    for (const status of [401, 403, 404]) {
      const { fetchImpl } = fakeFetch(() => ({ status, body: {} }));
      await expect(new HttpModelHubClient({ fetchImpl }).verify(REF)).rejects.toMatchObject({
        code: 'not_found',
      });
    }
  });

  it('refuses unsupported pipelines and a revision the hub resolves differently', async () => {
    const wrongPipeline = fakeFetch(() => ({
      status: 200,
      body: { ...MODEL_ITEM, pipeline_tag: 'text-to-image' },
    }));
    await expect(
      new HttpModelHubClient({ fetchImpl: wrongPipeline.fetchImpl }).verify(REF),
    ).rejects.toMatchObject({ code: 'unsupported_pipeline' });
    const wrongSha = fakeFetch(() => ({
      status: 200,
      body: { ...MODEL_ITEM, sha: 'b'.repeat(40) },
    }));
    await expect(
      new HttpModelHubClient({ fetchImpl: wrongSha.fetchImpl }).verify(REF),
    ).rejects.toMatchObject({ code: 'revision_mismatch' });
    // A revision response that does not echo a well-formed commit sha proves
    // nothing about the pin — verify fails closed rather than accepting it.
    const missingSha = fakeFetch(() => ({
      status: 200,
      body: { ...MODEL_ITEM, sha: undefined },
    }));
    await expect(
      new HttpModelHubClient({ fetchImpl: missingSha.fetchImpl }).verify(REF),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    const malformedSha = fakeFetch(() => ({
      status: 200,
      body: { ...MODEL_ITEM, sha: 'not-a-sha' },
    }));
    await expect(
      new HttpModelHubClient({ fetchImpl: malformedSha.fetchImpl }).verify(REF),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('TTL-caches successful reads (a second verify makes no second request)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { ...MODEL_ITEM, id: 'Qwen/Qwen3.6-27B', pipeline_tag: 'image-text-to-text' },
    }));
    let nowMs = 0;
    const client = new HttpModelHubClient({ fetchImpl, now: () => nowMs, cacheTtlMs: 1_000 });
    await client.verify(REF);
    await client.verify(REF);
    expect(calls).toHaveLength(1);
    nowMs = 2_000; // TTL elapsed ⇒ refetch
    await client.verify(REF);
    expect(calls).toHaveLength(2);
  });

  it('is a ModelHubError instance (the propose route narrows on it)', async () => {
    const { fetchImpl } = fakeFetch(() => 'reject');
    const error = await new HttpModelHubClient({ fetchImpl }).verify(REF).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelHubError);
  });

  it('a 5xx is transport and a non-JSON body is invalid_response (never cached)', async () => {
    const server500 = fakeFetch(() => ({ status: 500, body: {} }));
    await expect(
      new HttpModelHubClient({ fetchImpl: server500.fetchImpl }).verify(REF),
    ).rejects.toMatchObject({ code: 'transport' });
    let calls = 0;
    const badJson: HubFetchLike = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      };
    };
    const client = new HttpModelHubClient({ fetchImpl: badJson });
    await expect(client.verify(REF)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client.verify(REF)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls).toBe(2); // failures are never cached — the next call re-fetches
  });
});
