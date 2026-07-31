// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2 wallet client (WS-L review fix): the link/unlink MUTATIONS surface a
// step-up 401 as the typed StepUpRequiredError (so the retry dialog opens),
// exactly like the WS-D privacy mutations — never a generic API failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, resetApiClientState } from './api.js';
import { StepUpRequiredError } from './auth-api.js';
import { linkWallet, requestWalletUnlink } from './wallet-api.js';

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route-table fetch mock (mirrors auth-api.test.ts); serves the CSRF token. */
function mockRoutes(routes: Record<string, (body: unknown) => Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/csrf-token')) return jsonResponse({ token: 'csrf-token' });
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const key = `${method} ${new URL(url, 'http://localhost').pathname}`;
    const handler = routes[key];
    if (!handler) return jsonResponse({ error: { code: 'not_found', message: 'no route' } }, 404);
    return handler(body);
  }) as unknown as typeof fetch;
}

const STEP_UP_401 = () => jsonResponse({ status: 'step_up_required', methods: ['webauthn'] }, 401);

beforeEach(() => resetApiClientState());
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('wallet client step-up surfacing (WS-L review fix)', () => {
  it('linkWallet rejects a step-up 401 as StepUpRequiredError', async () => {
    mockRoutes({ 'POST /v1/wallet/link': STEP_UP_401 });
    await expect(linkWallet({ message: 'm', signature: '0xsig' })).rejects.toBeInstanceOf(
      StepUpRequiredError,
    );
  });

  it('requestWalletUnlink rejects a step-up 401 as StepUpRequiredError', async () => {
    mockRoutes({ 'POST /v1/wallet/unlink/request': STEP_UP_401 });
    await expect(requestWalletUnlink('w1')).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it('requestWalletUnlink still returns the typed 409 blocked outcome (not an error)', async () => {
    mockRoutes({
      'POST /v1/wallet/unlink/request': () =>
        jsonResponse(
          {
            error: { code: 'unlink_blocked', message: 'blocked' },
            blocking_obligations: [{ type: 'active_proposal', ref: 'p1', description: 'open' }],
          },
          409,
        ),
    });
    const result = await requestWalletUnlink('w1');
    expect('blocking_obligations' in result).toBe(true);
  });
});

describe('requestWalletUnlink error normalisation', () => {
  // WalletManager renders `error.message` verbatim in its status line, so a raw
  // ZodError (zod 4 serialises the whole issue array into `.message`) or a
  // SyntaxError would put an untranslated internal payload in front of the user
  // — the exact leak `parseResponse`'s ApiClientError normalisation prevents.
  it('normalises a MALFORMED 409 body to invalid_response, never a raw ZodError', async () => {
    mockRoutes({
      // A rollout skew: this 409 no longer matches the `.strict()` blocked shape.
      'POST /v1/wallet/unlink/request': () =>
        jsonResponse({ error: { code: 'unlink_blocked', message: 'blocked' } }, 409),
    });
    const error = await requestWalletUnlink('w1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('invalid_response');
    expect((error as ApiClientError).message).toBe('Server response failed validation');
  });

  it('normalises a NON-JSON 409 body too (json() throws SyntaxError)', async () => {
    mockRoutes({
      'POST /v1/wallet/unlink/request': () =>
        new Response('<html>gateway error</html>', {
          status: 409,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const error = await requestWalletUnlink('w1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('invalid_response');
  });

  it('routes a malformed 200 through parseResponse (the success path is not bypassed)', async () => {
    mockRoutes({
      'POST /v1/wallet/unlink/request': () => jsonResponse({ unlink_state: 'pending_unlink' }, 200),
    });
    const error = await requestWalletUnlink('w1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('invalid_response');
  });

  it('still returns a well-formed 200 accepted outcome', async () => {
    mockRoutes({
      'POST /v1/wallet/unlink/request': () =>
        jsonResponse(
          {
            wallet_account_id: '11111111-1111-4111-8111-111111111111',
            unlink_state: 'pending_unlink',
            finalize_after: '2026-07-29T00:00:00.000Z',
          },
          200,
        ),
    });
    const result = await requestWalletUnlink('w1');
    expect('unlink_state' in result && result.unlink_state).toBe('pending_unlink');
  });
});
