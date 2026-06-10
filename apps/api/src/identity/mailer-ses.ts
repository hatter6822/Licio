// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Mailer over the Amazon SES v2 HTTP API (WS-D email delivery) —
// SigV4 over fetch, no SDK dependency (the same pattern as the S3 ObjectStore).
// Templates are plain text and self-contained; the deletion notice honours the
// WS-D.2.4a acceptance criteria (what happens, the 30-day window, how to
// cancel, what cannot be reversed) and the cancel link lands on the login
// page's /login?cancel_token=… handler.
//
// Privacy (§19.1): this module never logs anything — not the recipient, not
// the code, not the token.  Failures throw with the HTTP status only, so an
// upstream logger can't accidentally capture PII from the error message.
import type { ServerEnv } from '@licio/shared/env';
import { sha256Hex } from './crypto.js';
import type { Mailer } from './services.js';
import { signRequest } from './sigv4.js';

export interface SesMailerConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** RFC 5322 From, e.g. "Licio <no-reply@licio.app>" (must be SES-verified). */
  fromAddress: string;
  /** Web-app origin for links in notices (the deletion-cancel page). */
  appOrigin: string;
  /** Override for tests/local stacks; defaults to the regional SES endpoint. */
  endpoint?: string;
}

/**
 * Derive the SES config from the validated env (all-or-none, enforced by the
 * env schema).  Null means "not configured": selectMailer then fails closed in
 * production unless the operator explicitly opted into a mail-less deployment.
 */
export function sesConfigFromEnv(
  env: Pick<
    ServerEnv,
    | 'SES_REGION'
    | 'SES_ACCESS_KEY_ID'
    | 'SES_SECRET_ACCESS_KEY'
    | 'SES_FROM_ADDRESS'
    | 'SES_ENDPOINT'
    | 'CORS_ORIGIN'
  >,
): SesMailerConfig | null {
  if (
    !env.SES_REGION ||
    !env.SES_ACCESS_KEY_ID ||
    !env.SES_SECRET_ACCESS_KEY ||
    !env.SES_FROM_ADDRESS
  ) {
    return null;
  }
  return {
    region: env.SES_REGION,
    accessKeyId: env.SES_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY,
    fromAddress: env.SES_FROM_ADDRESS,
    appOrigin: env.CORS_ORIGIN.replace(/\/$/, ''),
    ...(env.SES_ENDPOINT ? { endpoint: env.SES_ENDPOINT } : {}),
  };
}

const CODE_TEMPLATES = {
  login: {
    subject: 'Your Licio sign-in code',
    body: (code: string) =>
      `Your Licio sign-in code is:\n\n    ${code}\n\n` +
      'It expires in a few minutes and works once, in the browser that requested it.\n' +
      'If you did not request this code, you can ignore this email — no one can\n' +
      'sign in without it.',
  },
  verify: {
    subject: 'Confirm your email for Licio',
    body: (code: string) =>
      `Your Licio email confirmation code is:\n\n    ${code}\n\n` +
      'It expires in a few minutes and works once. If you did not request this,\n' +
      'you can ignore this email.',
  },
} as const;

export class SesMailer implements Mailer {
  readonly #cfg: SesMailerConfig;
  readonly #fetch: typeof fetch;

  constructor(cfg: SesMailerConfig, fetchFn: typeof fetch = fetch) {
    this.#cfg = cfg;
    this.#fetch = fetchFn;
  }

  async sendCode(to: string, code: string, kind: 'login' | 'verify'): Promise<void> {
    const template = CODE_TEMPLATES[kind];
    await this.#send(to, template.subject, template.body(code));
  }

  async sendNotice(to: string, kind: string, payload?: Record<string, string>): Promise<void> {
    switch (kind) {
      case 'deletion_requested': {
        const cancelUrl = `${this.#cfg.appOrigin}/login?cancel_token=${encodeURIComponent(
          payload?.['cancel_token'] ?? '',
        )}`;
        await this.#send(
          to,
          'Your Licio account is scheduled for deletion',
          'You (or someone with access to your account) asked us to delete your\n' +
            'Licio account.\n\n' +
            'What happens now: the account is deactivated immediately, your profile\n' +
            'is hidden, and after a 30-day grace period all personal data is\n' +
            'permanently removed.\n\n' +
            'Changed your mind? Cancel any time within 30 days by opening this link:\n\n' +
            `    ${cancelUrl}\n\n` +
            'or by signing in again with any of your sign-in methods.\n\n' +
            'What cannot be reversed: content already recorded on public\n' +
            'blockchains (if you linked a wallet) cannot be erased by anyone,\n' +
            'including us.',
        );
        return;
      }
      case 'duplicate_registration':
        await this.#send(
          to,
          'Was this you? A Licio sign-up used your email',
          'Someone just tried to create a Licio account with this email address,\n' +
            'which already belongs to an account.\n\n' +
            'If this was you: just sign in instead — request a sign-in code or use\n' +
            'your passkey.\n\n' +
            'If this was not you: no action is needed. No new account was created\n' +
            'and nothing about your account changed.',
        );
        return;
      case 'duplicate_email_add':
        await this.#send(
          to,
          'Was this you? Someone tried to add your email on Licio',
          'Someone tried to attach this email address to a different Licio\n' +
            'account. Because the address already belongs to your account, nothing\n' +
            'was changed.\n\n' +
            'If this was not you, no action is needed — but if it keeps happening,\n' +
            'consider reviewing your account security at ' +
            `${this.#cfg.appOrigin}/profile/security`,
        );
        return;
      default:
        // Fail loud: a typo'd kind must never silently send an empty email.
        throw new Error(`SES mailer: unknown notice kind ${JSON.stringify(kind)}`);
    }
  }

  /** Send one plain-text email via the SES v2 outbound-emails endpoint. */
  async #send(to: string, subject: string, text: string): Promise<void> {
    const endpoint = this.#cfg.endpoint ?? `https://email.${this.#cfg.region}.amazonaws.com`;
    const url = new URL('/v2/email/outbound-emails', endpoint);
    const body = Buffer.from(
      JSON.stringify({
        FromEmailAddress: this.#cfg.fromAddress,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Text: { Data: text, Charset: 'UTF-8' } },
          },
        },
      }),
      'utf8',
    );
    const payloadHash = sha256Hex(body);
    const headers = signRequest(
      {
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', 'x-amz-content-sha256': payloadHash },
        payloadHash,
      },
      {
        accessKeyId: this.#cfg.accessKeyId,
        secretAccessKey: this.#cfg.secretAccessKey,
        region: this.#cfg.region,
        service: 'ses',
      },
    );
    const res = await this.#fetch(url, { method: 'POST', headers, body: new Uint8Array(body) });
    // Status only — never the recipient or body — so error logs stay PII-free.
    if (!res.ok) throw new Error(`SES send failed: ${res.status}`);
  }
}
