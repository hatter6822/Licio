// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

// Load the repo-root .env (if present) so `pnpm db:migrate` / `db:generate` /
// `db:push` see DATABASE_URL without a manual shell export — matching the API
// dev server, which loads the same file. A no-op when the file is absent (the
// zero-setup dev path needs no database).
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // No root .env — DATABASE_URL is read from the process environment instead.
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
