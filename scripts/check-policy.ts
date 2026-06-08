// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLI gate for the WS-A doctrine & policy documents. Exits non-zero if any document is
// missing, malformed, internally inconsistent, or out of sync with another document.
// Wired into `pnpm check:policy`, CI (lint job), and lefthook pre-commit.

import { resolve } from 'node:path';
import { validatePolicyDocs } from './policy/validate.ts';

const ROOT = resolve(import.meta.dirname, '..');
const POLICY_DIR = resolve(ROOT, 'docs/policy');

const errors = validatePolicyDocs(POLICY_DIR);

if (errors.length > 0) {
  console.error('Policy doctrine validation FAILED:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log('Policy doctrine documents (WS-A): OK');
