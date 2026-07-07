// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2 wallet client (WS-L review fix): the link/unlink MUTATIONS surface a
// step-up 401 as the typed StepUpRequiredError (so the retry dialog opens),
// exactly like the WS-D privacy mutations — never a generic API failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientState } from './api.js';
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
