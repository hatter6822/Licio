// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Strict Markdown-lite parser (WS-G.4.1, SPEC §15.5/§25.2/§18.4) — stage one
// of the UGC defense-in-depth pipeline.  The parser NEVER emits HTML: it
// produces a closed AST whose node kinds are exactly the allowed elements
// (paragraph, heading h1–h3, strong, em, inline code, code block, link,
// blockquote, ordered/unordered list, soft break).  Raw HTML has no node kind,
// so tag passthrough is impossible by construction — `<script>` arrives as
// TEXT and leaves as escaped text.  Link destinations are normalized to
// http/https/mailto; every other scheme (javascript:, data:, vbscript:,
// file:, …) is dropped and the label survives as plain text.
//
// The grammar is line-based and deliberately small: no raw-HTML blocks, no
// images, no tables, no footnotes, no nested lists.  Malformed input degrades
// to literal text — the parser is total (it never throws on any string).
import { MAX_URL_LENGTH } from '../utils/url.js';
import { tryParseUrl } from './whatwg-url.js';

/** Inline AST nodes (the only phrasing content the serializer can emit). */
export type UgcInlineNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'softbreak' }
  | { readonly kind: 'strong'; readonly children: readonly UgcInlineNode[] }
  | { readonly kind: 'em'; readonly children: readonly UgcInlineNode[] }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly UgcInlineNode[] };

/** Block AST nodes (the only flow content the serializer can emit). */
export type UgcBlockNode =
  | { readonly kind: 'paragraph'; readonly children: readonly UgcInlineNode[] }
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3;
      readonly children: readonly UgcInlineNode[];
    }
  | { readonly kind: 'code_block'; readonly value: string }
  | { readonly kind: 'blockquote'; readonly children: readonly UgcBlockNode[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: ReadonlyArray<readonly UgcInlineNode[]>;
    };

export interface UgcDocument {
  readonly blocks: readonly UgcBlockNode[];
  /** True when the input exceeded {@link MAX_UGC_INPUT_LENGTH} and was truncated. */
  readonly truncated: boolean;
}

/** Hard input bound (WS-G.4.2b: >50KB input must degrade gracefully, never throw). */
export const MAX_UGC_INPUT_LENGTH = 50_000;

/** Blockquote nesting bound — recursion is depth-capped, never input-driven. */
const MAX_QUOTE_DEPTH = 8;

/** Inline-emphasis nesting bound. */
const MAX_INLINE_DEPTH = 16;

/**
 * Normalize a link destination to the allowed schemes (WS-G.4.1).
 * Returns the normalized URL, or null when the destination must be dropped.
 *
 *  - `http:` / `https:` / `mailto:` pass through.
 *  - Protocol-relative `//host/path` is normalized to `https://host/path`.
 *  - Every other scheme — including the javascript, data, and vbscript
 *    schemes, file URLs, and obfuscations using whitespace/control characters inside the
 *    scheme — is rejected.  Relative paths are rejected too: UGC links must
 *    be absolute, so a crafted relative URL can never resolve against an
 *    unexpected base.
 */
export function normalizeUgcLink(rawHref: string): string | null {
  // Strip ALL whitespace and ASCII control characters: HTML parsers ignore
  // them inside scheme names (`java\tscript:`), and a legitimate URL never
  // contains raw whitespace -- after stripping, scheme detection sees what a
  // browser would see.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping scheme-obfuscation control bytes is the security point
  const compact = rawHref.replace(/[\s\u0000-\u001f\u007f]+/g, '');
  if (compact.length === 0 || compact.length > MAX_URL_LENGTH) return null;
  if (compact.startsWith('//')) {
    return normalizeUgcLink(`https:${compact}`);
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!schemeMatch) return null; // relative or schemeless — rejected
  const scheme = (schemeMatch[1] ?? '').toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    // URL canonicalization (punycode host, escaped path) — also rejects
    // structurally invalid URLs like `https://`.
    const parsed = tryParseUrl(compact);
    if (parsed === null || parsed.hostname.length === 0) return null;
    return parsed.toString();
  }
  if (scheme === 'mailto') {
    // Keep mailto simple: a single address, no headers (no ?cc= injection).
    const address = compact.slice('mailto:'.length);
    if (/^[^\s@?&]+@[^\s@?&]+\.[^\s@?&]+$/.test(address)) return `mailto:${address}`;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Sticky (`y`) matchers anchored at the scan position — no per-character
// substring slicing, so inline parsing stays O(n) on the 50KB input bound.
// `lastIndex` is set immediately before every exec (single-threaded, no
// awaits between set and exec), so module-level instances are safe.
//
// Emphasis interiors are LENGTH-BOUNDED (`{0,EMPHASIS_MAX}?`, not `*?`). An
// unbounded lazy interior lets a single failed match walk to end-of-line, and
// `NEXT_SPECIAL_G` retries at EVERY delimiter, so a crafted run of `*`
// characters was O(n²) (50KB blocked the main thread for ~4.8s). The bound caps
// per-position work at a constant, restoring true O(n); emphasis never spans
// more than EMPHASIS_MAX chars, well beyond any real span.
//
// EMPHASIS_MAX and the URL quantifiers below were both spelled `2048` inline —
// so this comment named a constant that did not exist, and the link matchers
// re-spelled `MAX_URL_LENGTH` a fourth time. Building the patterns from the two
// named bounds makes the prose true and keeps the lexer's idea of "too long to
// be a URL" equal to the one `normalizeUgcLink` and every URL schema enforce; a
// lexer that accepted longer would hand the sanitizer a destination the
// normalizer always rejects.
const EMPHASIS_MAX = 2048;
const CODE_Y = /`([^`\n]+)`/y;
// Destination allows ONE level of balanced parens (Wikipedia-style URLs and
// script-scheme `alert(1)` payloads both parse as destinations — the latter
// is then dropped by scheme normalization, keeping the label).
const LINK_Y = new RegExp(
  `\\[([^\\]\\n]{0,512})\\]\\(((?:[^()\\s]|\\([^()\\s]*\\)){1,${MAX_URL_LENGTH}})\\)`,
  'y',
);
const ANGLE_Y = new RegExp(`<((?:https?://|mailto:)[^<>\\s]{1,${MAX_URL_LENGTH}})>`, 'iy');
const BARE_URL_Y = new RegExp(`https?://[^\\s<>"'\`]{1,${MAX_URL_LENGTH}}`, 'iy');
// Emphasis: lazy interiors with non-space edges; the closing run must not be
// followed by another delimiter of the same kind, so `**bold *em***` closes
// at the outermost run (nested emphasis parses) while `**a** and **b**` still
// closes at the first candidate.
const STRONG_Y = new RegExp(`\\*\\*(\\S(?:[^\\n]{0,${EMPHASIS_MAX}}?\\S)?)\\*\\*(?!\\*)`, 'y');
const EM_STAR_Y = new RegExp(`\\*(\\S(?:[^*\\n]{0,${EMPHASIS_MAX}}?\\S)?)\\*(?!\\*)`, 'y');
const EM_UNDERSCORE_Y = new RegExp(`_(\\S(?:[^_\\n]{0,${EMPHASIS_MAX}}?\\S)?)_(?!\\w)`, 'y');
/** Finds the next character that could begin a structured inline construct. */
const NEXT_SPECIAL_G = /[`[<*_]|https?:\/\//gi;

function stickyExec(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

function parseInline(text: string, depth: number): UgcInlineNode[] {
  const nodes: UgcInlineNode[] = [];
  let position = 0;
  let literal = '';

  const flushLiteral = (): void => {
    if (literal.length > 0) {
      nodes.push({ kind: 'text', value: literal });
      literal = '';
    }
  };

  while (position < text.length) {
    // Bulk-skip to the next character that could start a construct.
    NEXT_SPECIAL_G.lastIndex = position;
    const special = NEXT_SPECIAL_G.exec(text);
    if (special === null) {
      literal += text.slice(position);
      break;
    }
    if (special.index > position) {
      literal += text.slice(position, special.index);
      position = special.index;
    }

    // Inline code: `code` (no nesting inside; backticks bind tightest).
    const codeMatch = stickyExec(CODE_Y, text, position);
    if (codeMatch?.[1] !== undefined) {
      flushLiteral();
      nodes.push({ kind: 'code', value: codeMatch[1] });
      position += codeMatch[0].length;
      continue;
    }

    // Link: [label](destination) — label parsed recursively (no nested links).
    const linkMatch = stickyExec(LINK_Y, text, position);
    if (linkMatch && depth < MAX_INLINE_DEPTH) {
      const label = linkMatch[1] ?? '';
      const href = normalizeUgcLink(linkMatch[2] ?? '');
      flushLiteral();
      const children = parseInline(label, depth + 1).flatMap((n) =>
        n.kind === 'link' ? n.children : [n],
      );
      if (href !== null) {
        nodes.push({ kind: 'link', href, children });
      } else {
        // Dangerous scheme: the link is DROPPED, the label text survives.
        nodes.push(...(children.length > 0 ? children : [{ kind: 'text', value: label } as const]));
      }
      position += linkMatch[0].length;
      continue;
    }

    // Angle autolink: <https://example.org> (safe schemes only).
    const angleMatch = stickyExec(ANGLE_Y, text, position);
    if (angleMatch?.[1] !== undefined) {
      const href = normalizeUgcLink(angleMatch[1]);
      flushLiteral();
      if (href !== null) {
        nodes.push({ kind: 'link', href, children: [{ kind: 'text', value: angleMatch[1] }] });
      }
      position += angleMatch[0].length;
      continue;
    }

    // Bare autolink: an http(s) URL in running text.
    const bareMatch = stickyExec(BARE_URL_Y, text, position);
    if (bareMatch !== null) {
      // Trim trailing punctuation that is almost certainly sentence-level.
      // `.,;:!?` always trims; a trailing `)`/`]` trims ONLY when unbalanced,
      // so a balanced Wikipedia paren URL (`.../Foo_(bar)`) keeps its closer
      // (CommonMark autolink termination).
      let trimmed = bareMatch[0];
      for (;;) {
        const punct = /[.,;:!?]+$/.exec(trimmed);
        if (punct) {
          trimmed = trimmed.slice(0, punct.index);
          continue;
        }
        const last = trimmed[trimmed.length - 1];
        if (last === ')' || last === ']') {
          const opens = (trimmed.match(/[([]/g) ?? []).length;
          const closes = (trimmed.match(/[)\]]/g) ?? []).length;
          if (closes > opens) {
            trimmed = trimmed.slice(0, -1);
            continue;
          }
        }
        break;
      }
      const href = normalizeUgcLink(trimmed);
      flushLiteral();
      if (href !== null) {
        nodes.push({ kind: 'link', href, children: [{ kind: 'text', value: trimmed }] });
        position += trimmed.length;
        continue;
      }
      literal += text[position] ?? '';
      position += 1;
      continue;
    }

    // Strong: **text** (before em, since ** binds tighter than *).
    const strongMatch = stickyExec(STRONG_Y, text, position);
    if (strongMatch?.[1] !== undefined && depth < MAX_INLINE_DEPTH) {
      flushLiteral();
      nodes.push({ kind: 'strong', children: parseInline(strongMatch[1], depth + 1) });
      position += strongMatch[0].length;
      continue;
    }

    // Emphasis: *text* or _text_ (underscore never opens intraword:
    // `snake_case_name` stays literal — CommonMark-aligned).
    const underscoreIntraword =
      text[position] === '_' && position > 0 && /\w/.test(text[position - 1] ?? '');
    const emMatch =
      stickyExec(EM_STAR_Y, text, position) ??
      (underscoreIntraword ? null : stickyExec(EM_UNDERSCORE_Y, text, position));
    if (emMatch?.[1] !== undefined && depth < MAX_INLINE_DEPTH) {
      flushLiteral();
      nodes.push({ kind: 'em', children: parseInline(emMatch[1], depth + 1) });
      position += emMatch[0].length;
      continue;
    }

    literal += text[position] ?? '';
    position += 1;
  }

  flushLiteral();
  return nodes;
}

/** Parse the inline content of a multi-line paragraph (soft breaks between lines). */
function parseParagraphLines(lines: readonly string[]): UgcInlineNode[] {
  const out: UgcInlineNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ kind: 'softbreak' });
    out.push(...parseInline(line, 0));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const FENCE_RE = /^```[^`]*$/;
const UNORDERED_ITEM_RE = /^[-*]\s+(.*)$/;
const ORDERED_ITEM_RE = /^\d{1,9}\.\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;

function parseBlocks(lines: readonly string[], quoteDepth: number): UgcBlockNode[] {
  const blocks: UgcBlockNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    // Fenced code block — content is preserved verbatim as TEXT (escaped at
    // serialization), so "</pre><script>" inside a fence stays inert.
    if (FENCE_RE.test(line.trim())) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_RE.test((lines[index] ?? '').trim())) {
        content.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // closing fence (or EOF)
      blocks.push({ kind: 'code_block', value: content.join('\n') });
      continue;
    }

    // Heading h1–h3 (#### and deeper is NOT an allowed node: it stays literal
    // paragraph text rather than passing through as a larger heading).
    const heading = HEADING_RE.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2].trim(), 0),
      });
      index += 1;
      continue;
    }

    // Blockquote — consecutive `>` lines, parsed recursively (depth-capped).
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE_RE.exec(lines[index] ?? '');
        if (!quoted) break;
        inner.push(quoted[1] ?? '');
        index += 1;
      }
      if (quoteDepth < MAX_QUOTE_DEPTH) {
        blocks.push({ kind: 'blockquote', children: parseBlocks(inner, quoteDepth + 1) });
      } else {
        blocks.push({ kind: 'paragraph', children: parseParagraphLines(inner) });
      }
      continue;
    }

    // Lists — consecutive items of the same ordering; no nesting.
    const firstUnordered = UNORDERED_ITEM_RE.exec(line);
    const firstOrdered = ORDERED_ITEM_RE.exec(line);
    if (firstUnordered ?? firstOrdered) {
      const ordered = firstOrdered !== null && firstUnordered === null;
      const itemRe = ordered ? ORDERED_ITEM_RE : UNORDERED_ITEM_RE;
      const items: Array<readonly UgcInlineNode[]> = [];
      while (index < lines.length) {
        const item = itemRe.exec(lines[index] ?? '');
        if (!item || item[1] === undefined) break;
        items.push(parseInline(item[1], 0));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Paragraph — consecutive plain lines.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim().length === 0 ||
        FENCE_RE.test(current.trim()) ||
        HEADING_RE.test(current) ||
        QUOTE_RE.test(current) ||
        UNORDERED_ITEM_RE.test(current) ||
        ORDERED_ITEM_RE.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseParagraphLines(paragraph) });
  }

  return blocks;
}

/**
 * Parse Markdown-lite into the safe AST (WS-G.4.1).  Total function: any
 * string (including pathological input) yields a document; inputs beyond
 * {@link MAX_UGC_INPUT_LENGTH} are truncated and marked.
 */
export function parseUgcMarkdown(input: string): UgcDocument {
  if (typeof input !== 'string' || input.length === 0) {
    return { blocks: [], truncated: false };
  }
  const truncated = input.length > MAX_UGC_INPUT_LENGTH;
  const bounded = truncated ? input.slice(0, MAX_UGC_INPUT_LENGTH) : input;
  // Strip NUL and other C0 controls except \n and \t (they only ever serve
  // parser-differential attacks), then normalize newlines.
  const normalized = bounded
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing parser-differential control bytes is the security point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n');
  return { blocks: parseBlocks(normalized.split('\n'), 0), truncated };
}
