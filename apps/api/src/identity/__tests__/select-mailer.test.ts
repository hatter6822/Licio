// SPDX-License-Identifier: AGPL-3.0-or-later
//
// selectMailer fails CLOSED in production (Codex P1): with no real email provider
// wired, it refuses to boot rather than silently "succeed" email flows — unless
// the operator explicitly opts into a mail-less deployment.
import { describe, expect, it } from 'vitest';
import { selectMailer } from '../services.js';

const noop = () => {};

describe('selectMailer (fail closed in production)', () => {
  it('throws in production when no mailer is configured', () => {
    expect(() =>
      selectMailer({ nodeEnv: 'production', allowNullMailer: false, log: noop, warn: noop }),
    ).toThrow(/No email provider/);
  });

  it('returns a logging mailer in development (no throw)', () => {
    const events: string[] = [];
    const mailer = selectMailer({
      nodeEnv: 'development',
      allowNullMailer: false,
      log: (e) => events.push(e),
      warn: noop,
    });
    expect(typeof mailer.sendCode).toBe('function');
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

  it('uses the logging mailer under NODE_ENV=test without throwing', () => {
    expect(() =>
      selectMailer({ nodeEnv: 'test', allowNullMailer: false, log: noop, warn: noop }),
    ).not.toThrow();
  });
});
