// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.3e — the static no-key-request gate: NO support form, template,
// workflow copy, or user-facing surface may ASK for a private key or seed
// phrase (SPEC §25.6; §18.5 support-impersonation counter).  This sweeps the
// support-facing source trees for request-shaped phrasings ("enter your seed
// phrase", "provide your private key", …) so a regression is a TEST FAILURE,
// not a code-review hope.  Warning copy that tells users NEVER to share keys
// is explicitly permitted (that copy is the defense, not the vector).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = [
  // Server-side support/compliance surfaces (templates, workflows, copy).
  join(import.meta.dirname, '../moderation'),
  join(import.meta.dirname, '../compliance'),
  join(import.meta.dirname, '../routes'),
  // Client-side support-facing components (safety, wallet, treasury, compliance).
  join(import.meta.dirname, '../../../web/src/components/safety'),
  join(import.meta.dirname, '../../../web/src/components/wallet'),
  join(import.meta.dirname, '../../../web/src/components/treasury'),
  join(import.meta.dirname, '../../../web/src/components/compliance'),
];

/** Request-shaped phrasings — asking a user to SUPPLY key material. */
const FORBIDDEN_REQUESTS: RegExp[] = [
  /(enter|paste|provide|type|submit|send( us)?|share)\s+(your|the)\s+(private\s+key|seed\s+phrase|recovery\s+phrase|mnemonic)/i,
  /(private\s+key|seed\s+phrase|recovery\s+phrase|mnemonic)\s+(is\s+)?required/i,
  /placeholder\s*=\s*["'][^"']*(seed\s+phrase|private\s+key|mnemonic)/i,
];

/** Warning copy is permitted: a match on the SAME line as a never/fraud
 *  disclaimer is the defense, not the vector. */
const PERMITTED_CONTEXT = /never|fraudulent|will not ask|won't ask|do not (share|enter)|scam/i;

function* sourceFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // an optional root (e.g. a not-yet-created component dir)
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__tests__') yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) {
      yield path;
    }
  }
}

describe('WS-N.2.3e — no support surface requests private keys', () => {
  it('no request-shaped key/seed-phrase language exists in any support-facing source', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          for (const pattern of FORBIDDEN_REQUESTS) {
            if (pattern.test(line) && !PERMITTED_CONTEXT.test(line)) {
              offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
            }
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
