// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Static privacy invariant (SPEC §19.1): the application NEVER reads the client
// network address — not to log it, not to hash it, not to key a rate limiter on
// it.  This test sweeps every API source file for the address-bearing surfaces
// (the forwarded-address headers and the socket remote address) so a regression
// is a TEST FAILURE, not a code-review hope.  Abuse control is per-account,
// per-target-mailbox, and global-budget based — all identity-free.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(import.meta.dirname, '..');

/** Every way a Node/Hono server could observe the client address. */
const FORBIDDEN = [
  /x-forwarded-for/i,
  /x-real-ip/i,
  /cf-connecting-ip/i,
  /true-client-ip/i,
  /remoteAddress/,
  /getConnInfo/, // hono/conninfo — the socket-address helper
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no-client-address invariant (§19.1)', () => {
  it('no API source file reads the client network address', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push(`${file} matches ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
