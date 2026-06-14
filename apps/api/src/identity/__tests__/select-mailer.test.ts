// SPDX-License-Identifier: AGPL-3.0-or-later
//
// selectMailer fails CLOSED in production (Codex P1): with no real email provider
// wired, it refuses to boot rather than silently "succeed" email flows — unless
// the operator explicitly opts into a mail-less deployment.  In LOCAL
// development it surfaces the one-time code so the passwordless email flows are
// testable without a mail server; CI / NODE_ENV=test stay silent.
import { describe, expect, it } from 'vitest';
import { selectMailer } from '../services.js';

const noop = () => {};

/** Capture the (event, meta) pairs a mailer emits to its log callback. */
function recordingLog() {
  const entries: Array<{ event: string; meta: Record<string, unknown> }> = [];
  return {
    entries,
    log: (event: string, meta: Record<string, unknown>) => entries.push({ event, meta }),
  };
}

describe('selectMailer (fail closed in production)', () => {
  it('throws in production when no mailer is configured', () => {
    expect(() =>
      selectMailer({ nodeEnv: 'production', allowNullMailer: false, log: noop, warn: noop }),
    ).toThrow(/No email provider/);
  });

  it('surfaces the one-time code to the log in development (so dev can verify)', async () => {
    const { entries, log } = recordingLog();
    const mailer = selectMailer({
      nodeEnv: 'development',
      allowNullMailer: false,
      log,
      warn: noop,
    });
    await mailer.sendCode('dev@example.com', 'ABCD2345', 'verify');
    const entry = entries.find((e) => e.event === 'auth.mail.dev_code');
    expect(entry).toBeDefined();
    // The dev mailer is the substitute for an inbox: the code AND recipient are
    // logged so the developer can complete the real verify flow.
    expect(entry?.meta['code']).toBe('ABCD2345');
    expect(entry?.meta['to']).toBe('dev@example.com');
    expect(entry?.meta['kind']).toBe('verify');
  });

  it('surfaces notice payloads (e.g. deletion-cancel tokens) in development', async () => {
    const { entries, log } = recordingLog();
    const mailer = selectMailer({
      nodeEnv: 'development',
      allowNullMailer: false,
      log,
      warn: noop,
    });
    await mailer.sendNotice('dev@example.com', 'deletion_requested', { cancel_token: 'tok-123' });
    const entry = entries.find((e) => e.event === 'auth.mail.dev_notice');
    expect(entry?.meta['cancel_token']).toBe('tok-123');
  });

  it('allows an explicit mail-less production deployment, with a loud warning', async () => {
    const warns: string[] = [];
    const mailer = selectMailer({
      nodeEnv: 'production',
      allowNullMailer: true,
      log: noop,
      warn: (m) => warns.push(m),
    });
    await mailer.sendCode('x@example.com', '123456', 'login');
    expect(warns.some((w) => /DISABLED/.test(w))).toBe(true);
  });

  it('stays silent under an explicit mail-less opt-out even in development', async () => {
    const { entries, log } = recordingLog();
    const mailer = selectMailer({
      nodeEnv: 'development',
      allowNullMailer: true,
      log,
      warn: noop,
    });
    await mailer.sendCode('x@example.com', 'ABCD2345', 'verify');
    // The explicit opt-out wins: the silent logging mailer never logs the code.
    expect(entries.some((e) => e.meta['code'] === 'ABCD2345')).toBe(false);
  });

  it('uses the silent logging mailer under NODE_ENV=test (never logs the code)', async () => {
    const { entries, log } = recordingLog();
    const mailer = selectMailer({ nodeEnv: 'test', allowNullMailer: false, log, warn: noop });
    await mailer.sendCode('x@example.com', 'ABCD2345', 'verify');
    expect(entries.some((e) => e.meta['code'] === 'ABCD2345')).toBe(false);
  });
});
