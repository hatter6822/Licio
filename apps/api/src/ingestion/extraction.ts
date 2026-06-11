// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Metadata extraction (WS-F.1.4e, SPEC §14.2): author, publication date,
// publisher, media type, language, sensitivity, and the COPYRIGHT-BOUNDED
// excerpt (WS-F.1.4f — the full body is shingled in memory for dedup and
// embeddings, then discarded; only the bounded excerpt is ever stored or
// displayed). Supported metadata channels: Open Graph, Twitter Cards,
// standard HTML meta, JSON-LD (parsed with JSON.parse — extracted HTML is
// PARSED, never executed), <title>, and the html lang attribute.
//
// The tag scanner is a small quote-aware tokenizer (attribute values may
// contain `>`), not a regex over HTML — bounded input (the fetch layer caps
// bytes), no recursion, no execution. Dependency-free by design (api dep
// budget; SPEC §6.12.12).
//
// Language detection (WS-F.1.4e): document-declared language first (html
// lang / og:locale — the publisher's own declaration), then a deterministic
// stopword-frequency classifier over eight major languages, else `und`. The
// classifier is intentionally simple and HONEST about it: it is the
// graceful-degradation default behind the WS-K classifier seam.
import { canonicalizeBcp47, type MediaType, type SensitivityLabel } from '@licio/shared';

// ---------------------------------------------------------------------------
// Quote-aware tag scanning.
// ---------------------------------------------------------------------------

export interface ScannedTag {
  name: string;
  attributes: Record<string, string>;
}

/** Decode the common HTML entities (incl. numeric) in attribute/text values. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Scan attributes from `html` starting after a tag name; returns at `>`. */
function scanAttributes(
  html: string,
  start: number,
): { attributes: Record<string, string>; end: number } {
  const attributes: Record<string, string> = {};
  let i = start;
  while (i < html.length) {
    // Skip whitespace and the self-closing slash.
    while (i < html.length && /[\s/]/.test(html[i] as string)) i += 1;
    if (i >= html.length || html[i] === '>') break;
    // Attribute name.
    let name = '';
    while (i < html.length && !/[\s=/>]/.test(html[i] as string)) {
      name += (html[i] as string).toLowerCase();
      i += 1;
    }
    while (i < html.length && /\s/.test(html[i] as string)) i += 1;
    if (html[i] !== '=') {
      if (name.length > 0) attributes[name] = '';
      continue;
    }
    i += 1; // consume '='
    while (i < html.length && /\s/.test(html[i] as string)) i += 1;
    let value = '';
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      while (i < html.length && html[i] !== quote) {
        value += html[i];
        i += 1;
      }
      i += 1; // closing quote
    } else {
      while (i < html.length && !/[\s>]/.test(html[i] as string)) {
        value += html[i];
        i += 1;
      }
    }
    if (name.length > 0) attributes[name] = decodeEntities(value);
  }
  return { attributes, end: i };
}

/**
 * Scan the tags of interest from an HTML document: every <meta>/<link>, the
 * <html> tag, the <title> text, the JSON-LD script bodies, and the visible
 * paragraph text (script/style content excluded).
 */
export function scanHtml(html: string): {
  metas: ScannedTag[];
  links: ScannedTag[];
  htmlLang: string | null;
  title: string | null;
  jsonLdBlocks: string[];
  text: string;
} {
  const metas: ScannedTag[] = [];
  const links: ScannedTag[] = [];
  let htmlLang: string | null = null;
  let title: string | null = null;
  const jsonLdBlocks: string[] = [];
  const textParts: string[] = [];

  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open === -1) {
      textParts.push(html.slice(i));
      break;
    }
    textParts.push(html.slice(i, open));
    // Comments and doctype.
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[open + 1] === '!') {
      const close = html.indexOf('>', open);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    // Tag name.
    let j = open + 1;
    if (html[j] === '/') j += 1;
    let name = '';
    while (j < html.length && /[a-zA-Z0-9-]/.test(html[j] as string)) {
      name += (html[j] as string).toLowerCase();
      j += 1;
    }
    const closing = html[open + 1] === '/';
    const { attributes, end } = scanAttributes(html, j);
    const tagEnd = html.indexOf('>', end);
    i = tagEnd === -1 ? html.length : tagEnd + 1;
    if (closing) continue;

    if (name === 'meta') {
      metas.push({ name, attributes });
    } else if (name === 'link') {
      links.push({ name, attributes });
    } else if (name === 'html' && attributes['lang'] !== undefined) {
      htmlLang = attributes['lang'];
    } else if (name === 'title' && title === null) {
      const close = html.indexOf('</title', i);
      if (close !== -1) {
        title = decodeEntities(html.slice(i, close)).replace(/\s+/g, ' ').trim();
        i = close;
      }
    } else if (name === 'script') {
      const close = html.indexOf('</script', i);
      const bodyEnd = close === -1 ? html.length : close;
      const type = (attributes['type'] ?? '').toLowerCase();
      if (type.includes('ld+json')) jsonLdBlocks.push(html.slice(i, bodyEnd));
      i = bodyEnd; // script content is NEVER treated as text
    } else if (name === 'style') {
      const close = html.indexOf('</style', i);
      i = close === -1 ? html.length : close;
    }
  }
  const text = decodeEntities(textParts.join(' ')).replace(/\s+/g, ' ').trim();
  return { metas, links, htmlLang, title, jsonLdBlocks, text };
}

// ---------------------------------------------------------------------------
// Field extraction.
// ---------------------------------------------------------------------------

export interface ExtractedMetadata {
  title: string | null;
  author: string | null;
  publisher: string | null;
  publishedAt: string | null;
  mediaType: MediaType | null;
  description: string | null;
  language: string | null;
  /** Publisher meta robots directives (recorded + respected, WS-F.1.4f). */
  noindex: boolean;
  noarchive: boolean;
  canonicalUrl: string | null;
  /** The full visible text — used IN MEMORY for dedup/embedding, never stored. */
  bodyText: string;
}

function metaContent(metas: ScannedTag[], key: 'name' | 'property', value: string): string | null {
  for (const tag of metas) {
    if ((tag.attributes[key] ?? '').toLowerCase() === value) {
      const content = tag.attributes['content'];
      if (content !== undefined && content.trim().length > 0) return content.trim();
    }
  }
  return null;
}

/** Walk parsed JSON-LD for the first string at `path` over any node. */
function jsonLdValue(blocks: string[], keys: readonly string[]): string | null {
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    const queue: unknown[] = [parsed];
    while (queue.length > 0) {
      const node = queue.shift();
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      if (node === null || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
        if (value !== null && typeof value === 'object') {
          const name = (value as Record<string, unknown>)['name'];
          if (typeof name === 'string' && name.trim().length > 0) return name.trim();
        }
      }
      if (record['@graph'] !== undefined) queue.push(record['@graph']);
    }
  }
  return null;
}

const OG_TYPE_TO_MEDIA: Readonly<Record<string, MediaType>> = {
  article: 'article',
  'video.movie': 'video',
  'video.episode': 'video',
  'video.other': 'video',
  video: 'video',
  'music.song': 'podcast',
  podcast: 'podcast',
  dataset: 'dataset',
  report: 'report',
  book: 'document',
  image: 'image',
};

const JSONLD_TYPE_TO_MEDIA: Readonly<Record<string, MediaType>> = {
  newsarticle: 'article',
  article: 'article',
  blogposting: 'article',
  report: 'report',
  videoobject: 'video',
  podcastepisode: 'podcast',
  audioobject: 'podcast',
  dataset: 'dataset',
  imageobject: 'image',
  digitaldocument: 'document',
};

function parsePublishedAt(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Extract every supported metadata field from a fetched HTML document. */
export function extractMetadata(html: string, sourceDomain: string): ExtractedMetadata {
  const scanned = scanHtml(html);
  const { metas, links, jsonLdBlocks } = scanned;

  const title =
    metaContent(metas, 'property', 'og:title') ??
    metaContent(metas, 'name', 'twitter:title') ??
    jsonLdValue(jsonLdBlocks, ['headline']) ??
    scanned.title;

  const author =
    jsonLdValue(jsonLdBlocks, ['author']) ??
    metaContent(metas, 'name', 'author') ??
    metaContent(metas, 'property', 'article:author') ??
    metaContent(metas, 'name', 'twitter:creator');

  const publisher =
    metaContent(metas, 'property', 'og:site_name') ??
    jsonLdValue(jsonLdBlocks, ['publisher']) ??
    sourceDomain;

  const publishedAt = parsePublishedAt(
    metaContent(metas, 'property', 'article:published_time') ??
      jsonLdValue(jsonLdBlocks, ['datePublished']) ??
      metaContent(metas, 'name', 'date'),
  );

  const ogType = (metaContent(metas, 'property', 'og:type') ?? '').toLowerCase();
  let mediaType: MediaType | null = OG_TYPE_TO_MEDIA[ogType] ?? null;
  if (mediaType === null) {
    for (const block of jsonLdBlocks) {
      try {
        const parsed = JSON.parse(block) as { '@type'?: unknown } | Array<{ '@type'?: unknown }>;
        const nodes = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of nodes) {
          const type = typeof node?.['@type'] === 'string' ? node['@type'].toLowerCase() : '';
          if (JSONLD_TYPE_TO_MEDIA[type]) {
            mediaType = JSONLD_TYPE_TO_MEDIA[type] ?? null;
            break;
          }
        }
      } catch {
        // tolerated: malformed JSON-LD is simply skipped
      }
      if (mediaType !== null) break;
    }
  }

  const description =
    metaContent(metas, 'property', 'og:description') ??
    metaContent(metas, 'name', 'description') ??
    metaContent(metas, 'name', 'twitter:description');

  const ogLocale = metaContent(metas, 'property', 'og:locale');
  const declaredLanguage = scanned.htmlLang ?? ogLocale?.replace('_', '-') ?? null;

  const robotsMeta = (metaContent(metas, 'name', 'robots') ?? '').toLowerCase();
  const noindex = robotsMeta.includes('noindex');
  const noarchive = robotsMeta.includes('noarchive');

  let canonicalUrl: string | null = null;
  for (const link of links) {
    if ((link.attributes['rel'] ?? '').toLowerCase() === 'canonical') {
      canonicalUrl = link.attributes['href'] ?? null;
      break;
    }
  }

  return {
    title,
    author,
    publisher,
    publishedAt,
    mediaType,
    description,
    language: declaredLanguage,
    noindex,
    noarchive,
    canonicalUrl,
    bodyText: scanned.text,
  };
}

// ---------------------------------------------------------------------------
// Language detection (declared-first, stopword classifier fallback).
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlyArray<{ tag: string; words: readonly string[] }> = [
  { tag: 'en', words: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'was'] },
  { tag: 'es', words: ['el', 'la', 'de', 'que', 'los', 'las', 'una', 'por', 'con', 'para'] },
  { tag: 'de', words: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für'] },
  { tag: 'fr', words: ['le', 'la', 'les', 'des', 'est', 'dans', 'une', 'pour', 'que', 'avec'] },
  { tag: 'pt', words: ['de', 'que', 'não', 'uma', 'para', 'com', 'os', 'das', 'mais', 'como'] },
  { tag: 'it', words: ['il', 'di', 'che', 'la', 'per', 'una', 'sono', 'con', 'del', 'più'] },
  { tag: 'nl', words: ['de', 'het', 'een', 'van', 'en', 'dat', 'niet', 'voor', 'met', 'zijn'] },
  { tag: 'sv', words: ['och', 'att', 'det', 'som', 'en', 'på', 'är', 'av', 'för', 'med'] },
];

/**
 * Detect the content language: the document's own declaration when present
 * (validated BCP 47 shape), else the stopword classifier, else `und`.
 * Deterministic; the WS-K seam replaces the fallback, never the declaration.
 */
export function detectLanguage(declared: string | null, text: string): string {
  if (declared !== null) {
    const trimmed = declared.trim();
    if (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(trimmed)) return canonicalizeBcp47(trimmed);
  }
  const words = text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 2_000);
  if (words.length < 10) return 'und';
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  let bestTag = 'und';
  let bestScore = 0;
  for (const { tag, words: stops } of STOPWORDS) {
    let score = 0;
    for (const stop of stops) score += counts.get(stop) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestTag = tag;
    }
  }
  // Require a minimal signal density: ≥ 2% of tokens are this language's
  // stopwords, else the classifier honestly reports `und`.
  return bestScore / words.length >= 0.02 ? bestTag : 'und';
}

// ---------------------------------------------------------------------------
// Sensitivity classification (conservative lexicon; WS-K seam).
// ---------------------------------------------------------------------------

const SENSITIVITY_LEXICONS: ReadonlyArray<{ label: SensitivityLabel; terms: readonly string[] }> = [
  {
    label: 'graphic',
    terms: ['graphic violence', 'graphic images', 'beheading', 'mutilation', 'gore', 'dismember'],
  },
  {
    label: 'medical',
    terms: ['diagnosis', 'vaccine', 'oncology', 'epidemic', 'clinical trial', 'dosage', 'symptom'],
  },
  {
    label: 'political',
    terms: ['election', 'parliament', 'ballot', 'referendum', 'legislation', 'campaign rally'],
  },
  {
    label: 'crisis',
    terms: [
      'earthquake',
      'evacuation',
      'wildfire',
      'mass casualty',
      'state of emergency',
      'flood warning',
    ],
  },
];

/**
 * Conservative keyword sensitivity classifier (WS-F.1.4e): a label applies
 * only on an explicit lexicon hit, so the false-positive cost (an unneeded
 * content warning) stays low while obviously sensitive material is labeled.
 * The governed WS-K classifier replaces this behind the same seam.
 */
export function classifySensitivity(text: string): SensitivityLabel[] {
  const lower = text.toLowerCase();
  const labels: SensitivityLabel[] = [];
  for (const { label, terms } of SENSITIVITY_LEXICONS) {
    if (terms.some((term) => lower.includes(term))) labels.push(label);
  }
  return labels.length === 0 ? ['none'] : labels;
}

// ---------------------------------------------------------------------------
// Copyright-bounded excerpt (WS-F.1.4f).
// ---------------------------------------------------------------------------

/**
 * Bound a text to `maxChars` on a word boundary with an ellipsis. The bound
 * is a COPYRIGHT control: stored/displayed link-story content is limited to
 * this excerpt + attribution + the canonical link-out — full-body
 * redistribution is impossible because the full body is never persisted.
 */
export function boundedExcerpt(text: string, maxChars: number): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= maxChars) return collapsed;
  const slice = collapsed.slice(0, Math.max(1, maxChars - 1));
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > maxChars / 2 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}
