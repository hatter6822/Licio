// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SES mailer (WS-D email delivery): request shape against the SES v2 API
// (SigV4-signed, payload hash bound), the code/notice templates — including
// the deletion notice's WS-D.2.4a content (grace window, cancel link onto
// /login?cancel_token=…, irreversibility) — fail-loud unknown kinds, and
// PII-free errors.  The signer itself is pinned to the AWS vectors in
// sigv4.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { SesMailer, sesConfigFromEnv } from '../mailer-ses.js';
import { selectMailer } from '../services.js';

const CONFIG = {
  region: 'eu-west-1',
  accessKeyId: 'ses-access',
  secretAccessKey: 'ses-secret',
  fromAddress: 'Licio <no-reply@licio.app>',
  appOrigin: 'https://licio.app',
};

interface Sent {
  url: string;
  headers: Headers;
  body: {
    FromEmailAddress: string;
    Destination: { ToAddresses: string[] };
    Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } };
  };
}

function stubFetch(status = 200): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers as Record<string, string>),
      body: JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as Sent['body'],
    });
    return new Response(status === 200 ? '{"MessageId":"x"}' : '{"message":"denied"}', { status });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, sent };
}

describe('SesMailer', () => {
  it('POSTs a SigV4-signed SES v2 request with the bound payload hash', async () => {
    const { fetch, sent } = stubFetch();
    await new SesMailer(CONFIG, fetch).sendCode('user@example.com', 'AB12CD34', 'login');

    const req = sent[0] as Sent;
    expect(req.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    expect(req.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ses-access\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
    );
    expect(req.headers.get('x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
    expect(req.body.FromEmailAddress).toBe(CONFIG.fromAddress);
    expect(req.body.Destination.ToAddresses).toEqual(['user@example.com']);
  });

  it('renders distinct login vs verify code templates carrying the code', async () => {
    const { fetch, sent } = stubFetch();
    const mailer = new SesMailer(CONFIG, fetch);
    await mailer.sendCode('a@example.com', 'CODE1111', 'login');
    await mailer.sendCode('a@example.com', 'CODE2222', 'verify');

    expect(sent[0]?.body.Content.Simple.Subject.Data).toContain('sign-in code');
    expect(sent[0]?.body.Content.Simple.Body.Text.Data).toContain('CODE1111');
    expect(sent[1]?.body.Content.Simple.Subject.Data).toContain('Confirm your email');
    expect(sent[1]?.body.Content.Simple.Body.Text.Data).toContain('CODE2222');
  });

  it('deletion notice carries the grace window, the cancel link, and irreversibility', async () => {
    const { fetch, sent } = stubFetch();
    await new SesMailer(CONFIG, fetch).sendNotice('a@example.com', 'deletion_requested', {
      cancel_token: 'tok/+special',
    });
    const text = sent[0]?.body.Content.Simple.Body.Text.Data ?? '';
    expect(text).toContain('30-day');
    expect(text).toContain(
      `https://licio.app/login?cancel_token=${encodeURIComponent('tok/+special')}`,
    );
    expect(text).toMatch(/cannot be (erased|reversed)/i);
    expect(text).toContain('signing in again');
  });

  it('renders the duplicate-registration and duplicate-add notices', async () => {
    const { fetch, sent } = stubFetch();
    const mailer = new SesMailer(CONFIG, fetch);
    await mailer.sendNotice('a@example.com', 'duplicate_registration');
    await mailer.sendNotice('a@example.com', 'duplicate_email_add');
    expect(sent[0]?.body.Content.Simple.Body.Text.Data).toContain('sign in instead');
    expect(sent[1]?.body.Content.Simple.Body.Text.Data).toContain('nothing');
  });

  it('throws on an unknown notice kind instead of sending an empty email', async () => {
    const { fetch, sent } = stubFetch();
    await expect(
      new SesMailer(CONFIG, fetch).sendNotice('a@example.com', 'mystery'),
    ).rejects.toThrow(/unknown notice kind/);
    expect(sent).toHaveLength(0);
  });

  it('throws on a provider failure with a PII-free message', async () => {
    const { fetch } = stubFetch(403);
    await expect(
      new SesMailer(CONFIG, fetch).sendCode('secret-user@example.com', 'AB12CD34', 'login'),
    ).rejects.toSatisfy((err: unknown) => {
      const message = (err as Error).message;
      return (
        message.includes('403') && !message.includes('secret-user') && !message.includes('AB12CD34')
      );
    });
  });

  it('honours an endpoint override (local stacks/tests)', async () => {
    const { fetch, sent } = stubFetch();
    await new SesMailer({ ...CONFIG, endpoint: 'http://localhost:8005' }, fetch).sendCode(
      'a@example.com',
      'AB12CD34',
      'verify',
    );
    expect(sent[0]?.url).toBe('http://localhost:8005/v2/email/outbound-emails');
  });
});

describe('sesConfigFromEnv + selectMailer integration', () => {
  const ENV = {
    SES_REGION: 'eu-west-1',
    SES_ACCESS_KEY_ID: 'k',
    SES_SECRET_ACCESS_KEY: 's',
    SES_FROM_ADDRESS: 'no-reply@licio.app',
    SES_ENDPOINT: undefined,
    CORS_ORIGIN: 'https://licio.app/',
  };

  it('derives the config (origin trailing slash trimmed) and null when absent', () => {
    const cfg = sesConfigFromEnv(ENV);
    expect(cfg?.appOrigin).toBe('https://licio.app');
    expect(
      sesConfigFromEnv({ ...ENV, SES_REGION: undefined, SES_ACCESS_KEY_ID: undefined }),
    ).toBeNull();
  });

  it('selectMailer prefers SES over the fail-closed production refusal', () => {
    const mailer = selectMailer({
      nodeEnv: 'production',
      allowNullMailer: false,
      ses: sesConfigFromEnv(ENV),
      log: () => {},
      warn: () => {},
    });
    expect(mailer).toBeInstanceOf(SesMailer);
  });

  it('still fails closed in production without SES and without the opt-out', () => {
    expect(() =>
      selectMailer({
        nodeEnv: 'production',
        allowNullMailer: false,
        ses: null,
        log: () => {},
        warn: () => {},
      }),
    ).toThrow(/SES_\*/);
  });
});
