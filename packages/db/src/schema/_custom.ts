// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drizzle does not ship a first-class `bytea` column, so we define one.  Used
// for session-token hashes, keyed IP hashes, WebAuthn public keys/credential
// ids, encrypted TOTP secrets, and keyed wallet-address hashes — every place a
// raw secret or PII byte-string would otherwise sit in plaintext.
import { customType } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
