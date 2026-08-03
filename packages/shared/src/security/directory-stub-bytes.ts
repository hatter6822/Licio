// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The exact bytes a §21.1 directory-stub signature covers — encodable on BOTH
// sides of the trust boundary.
//
// The room signs its directory record with its founder Ed25519 key, and until
// now only the client could reproduce what was signed: the canonical DAG-CBOR
// encoder lives in `@licio/private-p2p`, which `apps/api` must not import (the
// server holds no per-room key, and the package boundary is what keeps it that
// way).  So the server stored `stub_signature` verbatim and verified nothing.
//
// That was tolerable while a record was only ever a claim about a room whose
// creator already held it.  It stopped being tolerable when "one record per
// room" made the room's public key a UNIQUE KEY: anyone who learns a detached
// room's founder public key — it travels in every invite — could claim that row
// under their own account with any 64-byte string as the signature, and the
// founder would be refused their own room forever, with only the squatter able
// to remove the forgery.
//
// The body is three ASCII strings, so its canonical encoding is a three-entry
// DAG-CBOR map and nothing more: definite-length, keys sorted by their ENCODED
// bytes, shortest-form arguments.  That is small enough to state here exactly,
// and `packages/private-p2p` cross-checks its full encoder against this one on
// every build (`directory-stub-bytes.test.ts`), so the two cannot drift into
// signatures one side makes and the other cannot verify.

/** The closed §8.2 body a v2 directory stub signs over. */
export interface SignedDirectoryStubBody {
  readonly schema: 'licio.private.directory_stub.v2';
  readonly room_public_key: string;
  readonly manifest_key_commitment: string;
}

const TEXT = new TextEncoder();

/** CBOR head byte(s) for a major type + argument, in shortest form. */
function argument(major: number, n: number): Uint8Array {
  const mt = major << 5;
  if (n < 24) return Uint8Array.of(mt | n);
  if (n < 0x100) return Uint8Array.of(mt | 24, n);
  if (n < 0x1_0000) return Uint8Array.of(mt | 25, (n >> 8) & 0xff, n & 0xff);
  // The three fields are a schema tag and two base64url commitments; none can
  // approach 64 KiB, and a longer one is a corrupted body rather than a case to
  // encode.
  throw new Error('directory stub field too long to be canonical');
}

function text(value: string): Uint8Array {
  const utf8 = TEXT.encode(value);
  const head = argument(3, utf8.length);
  const out = new Uint8Array(head.length + utf8.length);
  out.set(head, 0);
  out.set(utf8, head.length);
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < len; i += 1) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    if (ai !== bi) return ai - bi;
  }
  return a.length - b.length;
}

/**
 * The canonical bytes of `body` — what `stub_signature` is a signature OVER.
 *
 * Deterministic by construction: three entries, each key and value encoded in
 * shortest form, the entries ordered by their encoded key bytes exactly as
 * DAG-CBOR requires.
 */
export function canonicalDirectoryStubBytes(body: SignedDirectoryStubBody): Uint8Array {
  const entries = (
    [
      ['schema', body.schema],
      ['room_public_key', body.room_public_key],
      ['manifest_key_commitment', body.manifest_key_commitment],
    ] as const
  ).map(([key, value]) => ({ key: text(key), value: text(value) }));
  entries.sort((a, b) => compareBytes(a.key, b.key));

  const head = argument(5, entries.length);
  let size = head.length;
  for (const entry of entries) size += entry.key.length + entry.value.length;
  const out = new Uint8Array(size);
  out.set(head, 0);
  let at = head.length;
  for (const entry of entries) {
    out.set(entry.key, at);
    at += entry.key.length;
    out.set(entry.value, at);
    at += entry.value.length;
  }
  return out;
}

/** Whether `body` is the closed v2 shape this module can encode — the only one
 *  whose signature the server is able to check (a preserved v1 body was signed
 *  over a different field set, and the server cannot re-derive it). */
export function isSignedDirectoryStubBody(
  body: Record<string, unknown>,
): body is SignedDirectoryStubBody & Record<string, unknown> {
  return (
    body['schema'] === 'licio.private.directory_stub.v2' &&
    typeof body['room_public_key'] === 'string' &&
    typeof body['manifest_key_commitment'] === 'string'
  );
}
