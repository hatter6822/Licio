// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.2.3c — allowlist parity: the `uploads_content_type_allowed` DB CHECK
// must list EXACTLY the shared upload allowlist (images + documents + the two
// video containers). A drift in either direction (a type admitted by one layer
// but not the other) would let an upload pass the API and fail the DB, or vice
// versa. This introspects the Drizzle table (the migration's source of truth),
// so it runs in CI without a database.
import { UPLOAD_DOCUMENT_TYPES, UPLOAD_IMAGE_TYPES, UPLOAD_VIDEO_TYPES } from '@licio/shared';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { uploads } from '../schema/upload.js';

describe('WS-Q.2.3c — upload content-type allowlist parity', () => {
  it('the DB CHECK lists exactly the shared allowlist', () => {
    const shared = new Set<string>([
      ...UPLOAD_IMAGE_TYPES,
      ...UPLOAD_DOCUMENT_TYPES,
      ...UPLOAD_VIDEO_TYPES,
    ]);
    const { checks } = getTableConfig(uploads);
    const allow = checks.find((c) => c.name === 'uploads_content_type_allowed');
    if (!allow) throw new Error('uploads_content_type_allowed CHECK is missing');
    const rendered = new PgDialect().sqlToQuery(allow.value).sql;
    // Every shared type appears in the CHECK…
    for (const type of shared) expect(rendered).toContain(`'${type}'`);
    // …and the CHECK lists no extra quoted type beyond the shared set.
    const inCheck = new Set([...rendered.matchAll(/'([^']+)'/g)].map((m) => m[1] as string));
    expect([...inCheck].sort()).toEqual([...shared].sort());
  });
});
