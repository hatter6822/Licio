// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SQL identifier-length gate (SPEC §6.12 schema hygiene).
//
// Postgres does NOT reject an identifier longer than `NAMEDATALEN - 1` (63
// bytes by default) — it silently TRUNCATES it and emits only a NOTICE, which
// scrolls past in migrate output. That is benign until two DIFFERENT intended
// names agree on their first 63 bytes: they then truncate to the SAME stored
// name, and either the second CREATE fails with a duplicate-object error at
// migrate time, or a later `DROP CONSTRAINT` / `ALTER … RENAME` silently
// targets whichever one exists. Five Drizzle-derived foreign-key names were
// already landing truncated (renamed by migration 0097); this gate is what
// stops the class from coming back.
//
// It scans the HAND-AUTHORED migration SQL — the only place an identifier
// actually reaches the server, since `db:generate` is never run on this repo
// (CLAUDE.md) — and fails on any quoted identifier over the limit. The
// companion gated integration test (`packages/db/src/__tests__`) asserts the
// same property over the MIGRATED DATABASE, which additionally covers names
// Drizzle derives rather than spells out.
//
// Deliberately dependency-free so the `scripts`-rooted vitest project can unit
// test the pure core directly.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Postgres `NAMEDATALEN - 1`: the longest identifier stored without truncation. */
export const PG_MAX_IDENTIFIER_BYTES = 63;

/**
 * Keywords immediately after which a dollar-quoted span is PROCEDURAL CODE
 * rather than a data value: `DO $$ … $$` and `CREATE FUNCTION … AS $$ … $$`.
 */
const PROCEDURAL_BEFORE_DOLLAR: ReadonlySet<string> = new Set(['do', 'as']);

/**
 * Does the token history immediately before a `$tag$` mark it as procedural?
 *
 * `recent` holds the last three tokens, oldest first. The adjacent case covers
 * `DO $$` and `AS $$`, but `DO` also takes an optional language clause —
 * `DO LANGUAGE plpgsql $$ … $$` is valid and puts `plpgsql` next to the
 * delimiter, so an adjacency-only test read the body as DATA and skipped it
 * whole. That is the dangerous direction: the gate goes BLIND to real DDL
 * rather than merely noisy, which is how an over-long name would reach
 * Postgres and be truncated with the gate still green.
 */
function isProceduralContext(recent: readonly string[]): boolean {
  const last = recent[recent.length - 1] ?? '';
  if (PROCEDURAL_BEFORE_DOLLAR.has(last)) return true;
  // `DO LANGUAGE <lang> $$`
  return recent[recent.length - 3] === 'do' && recent[recent.length - 2] === 'language';
}

/**
 * Read a `"…"` body starting just after the opening quote, honouring the `""`
 * escape. Returns the raw body and the offset just past the closing quote, or
 * `null` when unterminated.
 */
function parseQuotedBody(sql: string, start: number): { body: string; end: number } | null {
  let body = '';
  let i = start;
  while (i < sql.length) {
    if (sql[i] === '"') {
      if (sql[i + 1] === '"') {
        body += '"';
        i += 2;
      } else return { body, end: i + 1 };
    } else {
      body += sql[i];
      i += 1;
    }
  }
  return null;
}

/**
 * Read the optional `UESCAPE '<char>'` clause that may follow a `U&"…"`
 * literal and redefine its escape character. Returns the character in force
 * (default `\`) and the offset just past the clause.
 */
function readUescape(sql: string, start: number): { char: string; end: number } {
  const m = /^\s*UESCAPE\s*'(.)'/i.exec(sql.slice(start));
  if (!m?.[1]) return { char: '\\', end: start };
  return { char: m[1], end: start + m[0].length };
}

/**
 * Decode the escapes inside a `U&"…"` body: `EE` is a literal escape
 * character, `EXXXX` a UTF-16 code unit, and `E+XXXXXX` a code point.
 *
 * The 4-hex form is decoded with `fromCharCode` rather than `fromCodePoint` so
 * that a surrogate PAIR written as two escapes combines into one character, as
 * Postgres treats it — decoding each half independently would count three
 * bytes per lone surrogate and inflate the measurement.
 */
function decodeUnicodeEscapes(body: string, escapeChar: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] !== escapeChar) {
      out += body[i];
      i += 1;
      continue;
    }
    if (body[i + 1] === escapeChar) {
      out += escapeChar;
      i += 2;
      continue;
    }
    if (body[i + 1] === '+') {
      const hex = body.slice(i + 2, i + 8);
      if (/^[0-9A-Fa-f]{6}$/.test(hex)) {
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 8;
        continue;
      }
    }
    const hex = body.slice(i + 1, i + 5);
    if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
      continue;
    }
    // Not a well-formed escape: Postgres would reject the literal outright, so
    // keep the character and let the length check see it rather than guessing.
    out += body[i];
    i += 1;
  }
  return out;
}

/**
 * Decode a Postgres ESCAPE STRING (`E'…'`) body. Unlike an ordinary literal,
 * backslash sequences here are interpreted by the server, so the identifier it
 * actually creates can be far longer than the text as written — a 64-character
 * name spelled as 64 `\x61` escapes is 256 bytes of source and 64 bytes of
 * identifier. Measuring the undecoded text scans short `x61` fragments and
 * reports nothing.
 */
function decodeEscapeString(body: string): string {
  let out = '';
  let i = 0;
  const SIMPLE: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
  };
  while (i < body.length) {
    if (body[i] !== '\\') {
      out += body[i];
      i += 1;
      continue;
    }
    const next = body[i + 1] ?? '';
    // \xHH — one or two hex digits.
    const hex = /^x([0-9A-Fa-f]{1,2})/.exec(body.slice(i + 1));
    if (hex?.[1]) {
      out += String.fromCharCode(Number.parseInt(hex[1], 16));
      i += 1 + hex[0].length;
      continue;
    }
    // \uXXXX and \UXXXXXXXX.
    const uni = /^(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/.exec(body.slice(i + 1));
    if (uni?.[1]) {
      out += String.fromCodePoint(Number.parseInt(uni[1].slice(1), 16));
      i += 1 + uni[0].length;
      continue;
    }
    // \ooo — one to three OCTAL digits.
    const oct = /^([0-7]{1,3})/.exec(body.slice(i + 1));
    if (oct?.[1]) {
      out += String.fromCharCode(Number.parseInt(oct[1], 8));
      i += 1 + oct[0].length;
      continue;
    }
    if (SIMPLE[next] !== undefined) {
      out += SIMPLE[next];
      i += 2;
      continue;
    }
    // Any other escaped character stands for itself.
    out += next;
    i += 2;
  }
  return out;
}

/**
 * Does a string literal plausibly hold SQL rather than data?
 *
 * Used only for the `AS '…'` function-body form. `CREATE FUNCTION … AS 'obj',
 * 'symbol'` names a C object file and link symbol — plain data that would be
 * reported as an over-long identifier if a path ran past the limit. Requiring
 * a statement keyword keeps the legacy plpgsql body scanned without turning
 * every `AS` literal into SQL.
 */
function looksLikeSql(text: string): boolean {
  return /\b(?:begin|create|alter|drop|select|insert|update|delete|execute)\b/i.test(text);
}

/**
 * Split SQL into the spans that can hold an identifier, discarding the spans
 * that cannot: `--` line comments, `/* … *\/` block comments (nesting, which
 * Postgres allows), `'…'` string literals (with the `''` escape), and
 * dollar-quoted VALUE literals.
 *
 * Scanning rather than regex-replacing because the constructs interleave: a
 * string can contain `--`, a comment can contain an apostrophe, and a
 * sequential set of replaces gets both wrong.
 *
 * Dollar quoting is CONTEXT-DEPENDENT and both readings are needed. After `DO`
 * or `AS` the body is procedural code — migration 0097's `DO $$ … $$` block
 * contains real DDL whose identifiers must be measured — so only the
 * delimiters are skipped. Everywhere else `$$…$$` is just a string literal
 * (`INSERT … VALUES ($$text$$)`), and tokenising that as SQL would report the
 * prose inside it as an over-long identifier and fail a perfectly valid
 * migration. Treating every dollar-quoted span as code makes the gate reject
 * correct input; treating every one as data would blind it to 0097's DDL.
 *
 * Yields `{ text, quoted }` runs: `quoted` marks a `"…"` delimited identifier,
 * which may legally contain characters a bare identifier may not.
 */
export function* identifierCandidates(sql: string): Generator<{ text: string; quoted: boolean }> {
  let i = 0;
  const n = sql.length;
  // The last three bare tokens seen, lower-cased, oldest first — enough to
  // recognise `DO LANGUAGE <lang> $$` as well as the adjacent `DO`/`AS` forms.
  let recent: string[] = [];
  // The tag of the PROCEDURAL body currently open, if any. Its matching close
  // is a delimiter to skip, not the start of a new literal (the token before it
  // is `END`, which would otherwise read as data).
  let openProceduralTag: string | null = null;
  // Set by an `E`/`e` prefix: the NEXT single-quoted literal is an escape
  // string and its backslash sequences must be decoded before it is measured.
  let pendingEscapeString = false;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    // -- line comment
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    // /* block comment */ (Postgres nests these)
    if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const t = sql.slice(i, i + 2);
        if (t === '/*') {
          depth += 1;
          i += 2;
        } else if (t === '*/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      continue;
    }
    // 'string literal' — '' is an escaped quote, not a terminator
    if (sql[i] === "'") {
      i += 1;
      let literal = '';
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            literal += "'";
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          literal += sql[i];
          i += 1;
        }
      }
      // The `''` escapes are already collapsed above; an ESCAPE string needs
      // its backslash sequences decoded too, since that is what the server
      // parses.
      const decoded = pendingEscapeString ? decodeEscapeString(literal) : literal;
      pendingEscapeString = false;
      const previous = recent[recent.length - 1];
      // A literal that is the argument of PL/pgSQL's `EXECUTE` is not data —
      // Postgres runs it as SQL, so an over-long name inside it truncates
      // exactly like one written out.
      //
      // The same is true of the LEGACY function-body form,
      // `CREATE FUNCTION … AS 'BEGIN … END' LANGUAGE plpgsql`: the body is
      // procedural code, exactly as in the dollar-quoted spelling that is
      // already scanned. It carries the `looksLikeSql` guard because `AS` also
      // introduces the C-language `AS 'objfile', 'symbol'` form, which is data.
      if (previous === 'execute' || (previous === 'as' && looksLikeSql(decoded))) {
        yield* identifierCandidates(decoded);
      }
      recent = [];
      continue;
    }
    // $tag$ … $tag$ — data literal or procedural body, per the context above.
    // The TAG follows unquoted-identifier rules, so it may contain digits after
    // its first character (`$q1$`, `$version_2$`). A letters-only class failed
    // to recognise those as delimiters at all, so the quoted prose between them
    // was tokenised as SQL and reported as an over-long identifier.
    const dollar = /^\$(?:[A-Za-z_-￿][A-Za-z0-9_-￿]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      if (openProceduralTag === tag) {
        // Closing delimiter of the procedural body: skip the delimiter only.
        openProceduralTag = null;
        i += tag.length;
        continue;
      }
      if (openProceduralTag === null && isProceduralContext(recent)) {
        // `DO $$` / `AS $$` / `DO LANGUAGE … $$`: the body is code, so scan it.
        openProceduralTag = tag;
        i += tag.length;
        continue;
      }
      // A value literal (including one nested inside a procedural body): skip
      // the ENTIRE span. An unterminated literal consumes the rest rather than
      // spilling its prose into the identifier stream.
      const close = sql.indexOf(tag, i + tag.length);
      const bodyEnd = close === -1 ? n : close;
      // …unless it is the argument of `EXECUTE`, in which case the span is
      // SQL the server runs — the dollar-quoted counterpart of the string
      // case above, and the form used precisely when the dynamic statement
      // contains quotes.
      if (recent[recent.length - 1] === 'execute') {
        yield* identifierCandidates(sql.slice(i + tag.length, bodyEnd));
      }
      i = close === -1 ? n : close + tag.length;
      recent = [];
      continue;
    }
    // U&"…" — a Unicode-escaped identifier. Postgres stores the DECODED name,
    // so measuring the escape notation over-counts by up to 6x and would reject
    // a migration whose real identifier is far inside the limit.
    const uAmp = /^[Uu]&"/.exec(sql.slice(i));
    if (uAmp) {
      const parsed = parseQuotedBody(sql, i + uAmp[0].length);
      if (parsed === null) return; // unterminated: stop rather than mis-parse
      const uescape = readUescape(sql, parsed.end);
      yield { text: decodeUnicodeEscapes(parsed.body, uescape.char), quoted: true };
      i = uescape.end;
      recent = [];
      continue;
    }
    // "quoted identifier" — `""` is an ESCAPED quote inside the name, not a
    // terminator. Stopping at the first quote would split a single 64-byte
    // identifier into two sub-limit halves, and both would pass. The DECODED
    // name is what Postgres stores and therefore what must be measured.
    if (sql[i] === '"') {
      i += 1;
      let decoded = '';
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            decoded += '"';
            i += 2;
          } else {
            i += 1;
            closed = true;
            break;
          }
        } else {
          decoded += sql[i];
          i += 1;
        }
      }
      if (!closed) return; // unterminated: stop rather than mis-parse the rest
      yield { text: decoded, quoted: true };
      continue;
    }
    // Bare identifier / keyword token. Postgres's unquoted-identifier set is
    // NOT ASCII-only: any character with the high bit set is a valid letter, so
    // `é…` is one identifier the server truncates like any other. An
    // ASCII-only class silently skipped the leading `é` and measured only the
    // shorter suffix, letting a 64-byte name through.
    const bare = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/.exec(sql.slice(i));
    if (bare) {
      // `$` is legal INSIDE a bare identifier, so `END$$` would otherwise be
      // consumed whole and the dollar-quote delimiter never seen \u2014 leaving a
      // procedural body open for the rest of the file. Stop the token at a
      // `$$`, which can only be a delimiter.
      const dd = bare[0].indexOf('$$');
      const text = dd > 0 ? bare[0].slice(0, dd) : bare[0];
      // A single-letter STRING PREFIX is part of the literal's syntax, not a
      // token of its own: `E'…'` (escape), `B'…'` (bit), `X'…'` (hex). Pushing
      // it onto the history would displace the `EXECUTE` that precedes it, so
      // `EXECUTE E'CREATE INDEX …'` would read as an ordinary data literal and
      // the dynamic DDL inside would go unscanned.
      if (/^[EeBbXx]$/.test(text) && sql[i + text.length] === "'") {
        // `E'…'` additionally makes the NEXT literal an escape string, whose
        // backslash sequences the server decodes before parsing.
        pendingEscapeString = /^[Ee]$/.test(text);
        i += text.length;
        continue;
      }
      recent.push(text.toLowerCase());
      if (recent.length > 3) recent.shift();
      yield { text, quoted: false };
      i += text.length;
      continue;
    }
    i += 1;
  }
}

/**
 * Over-long identifiers in migrations that are ALREADY APPLIED and therefore
 * immutable history. Migration 0097 renames what these created, so the live
 * schema carries the short names; the SQL text cannot be edited without
 * diverging from every database that has already run it.
 *
 * Each exemption is SCOPED TO THE FILES that already contain it: the migration
 * that originally created the name, plus 0097 itself (which must spell the old
 * name to rename it). A name-only exemption would be a permanent licence to
 * reuse these five names — a NEW migration spelling one would inherit the pass
 * and be truncated exactly as before, which is the very defect this gate
 * exists to catch. Immutable history is the reason to exempt; it does not
 * extend to files that have not been written yet.
 *
 * This list is CLOSED. Do not add to it: a new over-long identifier is a bug to
 * fix in the migration being written, not a precedent to extend.
 */
const RENAME_MIGRATION = '0097_constraint_name_truncation.sql';

const HISTORICAL_EXEMPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'debate_arenas_challenger_contribution_id_contributions_contribution_id_fk',
    new Set(['0056_ws_t_debate_arena.sql', RENAME_MIGRATION]),
  ],
  [
    'debate_arenas_target_contribution_id_contributions_contribution_id_fk',
    new Set(['0056_ws_t_debate_arena.sql', RENAME_MIGRATION]),
  ],
  [
    'steward_governance_vote_election_id_steward_election_election_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms.sql', RENAME_MIGRATION]),
  ],
  [
    'room_governance_prompt_model_id_room_governance_model_model_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms.sql', RENAME_MIGRATION]),
  ],
  [
    'room_agent_binding_prompt_id_room_governance_prompt_prompt_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms.sql', RENAME_MIGRATION]),
  ],
]);

export interface IdentifierViolation {
  file: string;
  identifier: string;
  bytes: number;
}

/**
 * Find identifiers Postgres would truncate in one migration's SQL. Pure.
 *
 * Scans BOTH `"quoted"` and bare identifiers. The bare case matters because
 * migrations here are hand-authored: `CREATE INDEX a…64_bytes ON t (c)` is
 * valid SQL that Postgres truncates just as silently, and — unlike the quoted
 * case — the catalog backstop can never recover it after the fact, because the
 * server stores only the 63-byte result. The static scan is the ONLY general
 * protection against it, so it has to see unquoted names.
 *
 * Scanning every bare token (not just DDL name positions) is safe precisely
 * because the only thing reported is a token OVER the limit: no SQL keyword is
 * anywhere near 63 bytes, so a bare token that long is an identifier by
 * construction. That avoids enumerating every DDL form — `CREATE INDEX`,
 * `ADD CONSTRAINT`, `CREATE TRIGGER`, `RENAME CONSTRAINT … TO …` — and the
 * inevitable gap in that list.
 *
 * Length is measured in BYTES, not characters: `NAMEDATALEN` bounds the byte
 * length, so a multi-byte identifier truncates sooner than its character count
 * suggests (and truncation can even split a UTF-8 sequence).
 */
export function findOverlongIdentifiers(filename: string, sql: string): IdentifierViolation[] {
  const violations: IdentifierViolation[] = [];
  const seen = new Set<string>();
  for (const { text } of identifierCandidates(sql)) {
    if (seen.has(text)) continue;
    seen.add(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > PG_MAX_IDENTIFIER_BYTES && !HISTORICAL_EXEMPTIONS.get(text)?.has(filename)) {
      violations.push({ file: filename, identifier: text, bytes });
    }
  }
  return violations;
}

function main(): void {
  const root = resolve(import.meta.dirname, '..');
  const dir = resolve(root, 'packages/db/drizzle');
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`SQL identifier check FAILED: ${dir} is not a directory`);
    process.exit(1);
  }

  const violations: IdentifierViolation[] = [];
  let scanned = 0;
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    scanned += 1;
    violations.push(...findOverlongIdentifiers(name, readFileSync(join(dir, name), 'utf-8')));
  }

  if (violations.length > 0) {
    console.error('SQL identifier check FAILED — Postgres would TRUNCATE these to 63 bytes:');
    for (const v of violations) {
      console.error(`  - ${v.file}: "${v.identifier}" (${v.bytes} bytes)`);
      console.error(`      truncates to "${v.identifier.slice(0, PG_MAX_IDENTIFIER_BYTES)}"`);
    }
    console.error(
      '\n  Give the object an EXPLICIT short name. For a Drizzle foreign key that means the\n' +
        '  table-level `foreignKey({ columns, foreignColumns, name })` form — inline\n' +
        '  `.references()` cannot name a constraint, so it derives\n' +
        '  `<table>_<column>_<fktable>_<fkcolumn>_fk`, which overflows easily.',
    );
    process.exit(1);
  }

  console.log(
    `SQL identifier check passed: ${scanned} migrations, no identifier over ${PG_MAX_IDENTIFIER_BYTES} bytes.`,
  );
}

// Run as a CLI only; importing for tests must not trigger the scan.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
