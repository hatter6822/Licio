// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T sourced comments — derive a comment's "sourced statements" and its
// canonical Citation[] from the INLINE Markdown links in its body.
//
// A source is attached in the composer by turning the sourced span of text into
// a link to the source (the sourced statement becomes a footnoted link).  The
// structured `citations` array is then DERIVED from those inline links — the
// body is the single source of truth, so the two can never drift (a parallel
// URL list that the author edits separately from the prose can).  The read view
// mirrors this: the numbered "Sources" footnote list is exactly the set of
// inline links.
//
// This reuses the ONE sanctioned Markdown-lite parser (`parseUgcMarkdown`), so
// what counts as a source is exactly what renders as a link through the UGC
// sink — no second, drift-prone link grammar.
import { type Citation, citationUrlSchema, MAX_CITATIONS } from '../schemas/contribution.js';
import { parseUgcMarkdown, type UgcBlockNode, type UgcInlineNode } from './markdown.js';

export interface SourcedStatement {
  /** The linked (sourced) text as it appears in the comment — the footnote subject. */
  statement: string;
  /** The destination URL (already scheme-normalized by the Markdown-lite parser). */
  url: string;
}

/** Citation-title cap (mirrors {@link Citation.title} `.max(300)`). */
const CITATION_TITLE_MAX = 300;

/** Flatten an inline run to its visible text (emphasis/link children included). */
function flattenInlineText(nodes: readonly UgcInlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
        out += node.value;
        break;
      case 'softbreak':
        out += ' ';
        break;
      case 'strong':
      case 'em':
      case 'link':
        out += flattenInlineText(node.children);
        break;
    }
  }
  return out;
}

/** Collect link nodes from an inline run (a link nests only inside emphasis). */
function collectInlineLinks(nodes: readonly UgcInlineNode[], out: SourcedStatement[]): void {
  for (const node of nodes) {
    if (node.kind === 'link') {
      const statement = flattenInlineText(node.children).trim();
      out.push({ statement: statement.length > 0 ? statement : node.href, url: node.href });
    } else if (node.kind === 'strong' || node.kind === 'em') {
      collectInlineLinks(node.children, out);
    }
  }
}

/** Walk the block tree collecting every inline link in document order. */
function walkBlocks(blocks: readonly UgcBlockNode[], out: SourcedStatement[]): void {
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        collectInlineLinks(block.children, out);
        break;
      case 'blockquote':
        walkBlocks(block.children, out);
        break;
      case 'list':
        for (const item of block.items) collectInlineLinks(item, out);
        break;
      case 'code_block':
        break;
    }
  }
}

/**
 * Every inline link in `body`, in document order, as a `{statement, url}` pair.
 * The statement is the link's visible text (falling back to the URL for a bare
 * `<url>` link).  Empty/whitespace input yields an empty array (never throws).
 */
export function extractSourcedStatements(body: string | null | undefined): SourcedStatement[] {
  if (!body) return [];
  const out: SourcedStatement[] = [];
  walkBlocks(parseUgcMarkdown(body).blocks, out);
  return out;
}

/**
 * The canonical `Citation[]` for a comment body, DERIVED from its inline links:
 * only citation-valid `http(s)`/`doi:` links, DEDUPED by URL (the first
 * statement wins as the title), capped at {@link MAX_CITATIONS}.  A `mailto:`
 * (or otherwise non-citation) link still renders but is not a citation, since
 * `citationUrlSchema` rejects it.
 */
export function deriveCitationsFromBody(body: string | null | undefined): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const { statement, url } of extractSourcedStatements(body)) {
    if (seen.has(url)) continue;
    if (!citationUrlSchema.safeParse(url).success) continue;
    seen.add(url);
    const title = statement.slice(0, CITATION_TITLE_MAX).trim();
    citations.push(title.length > 0 && title !== url ? { url, title } : { url });
    if (citations.length >= MAX_CITATIONS) break;
  }
  return citations;
}

/**
 * Merge a comment's inline sourced statements with any stored `citations` whose
 * URL is not itself an inline link (legacy comments authored with the old,
 * separate source-URL list carry bare citations with no matching body link).
 * Used by the read-view "Sources" footnote list so both new and legacy comments
 * show a complete, de-duplicated set — each with the best statement text known.
 */
export function resolveCommentSources(
  body: string | null | undefined,
  citations: readonly Citation[],
): SourcedStatement[] {
  const out: SourcedStatement[] = [];
  const seen = new Set<string>();
  for (const statement of extractSourcedStatements(body)) {
    if (seen.has(statement.url)) continue;
    seen.add(statement.url);
    out.push(statement);
  }
  for (const citation of citations) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push({ statement: citation.title ?? citation.url, url: citation.url });
  }
  return out;
}
