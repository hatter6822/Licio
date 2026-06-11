// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drizzle does not ship a first-class `bytea` column, so we define one.  Used
// for session-token hashes, keyed IP hashes, WebAuthn public keys/credential
// ids, encrypted TOTP secrets, keyed wallet-address hashes, and persisted
// MinHash signatures — every place a raw secret, PII byte-string, or packed
// binary vector would otherwise sit in plaintext/inflated form.
import { customType } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * PostgreSQL full-text `tsvector` (WS-F.3.1a).  Used only for GENERATED
 * ALWAYS AS … STORED search columns — application code never writes one
 * directly, so the data type is the serialized lexeme form for reads.
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});
