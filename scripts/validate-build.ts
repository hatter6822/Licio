// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST_DIR = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist');
const INDEX_HTML = resolve(DIST_DIR, 'index.html');

const EVENT_HANDLER_ATTRS = [
  'onclick',
  'onload',
  'onerror',
  'onsubmit',
  'onfocus',
  'onblur',
  'onchange',
  'oninput',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onmouseover',
  'onmouseout',
  'onmousedown',
  'onmouseup',
  'ondblclick',
  'oncontextmenu',
  'onwheel',
  'ondrag',
  'ondrop',
  'onscroll',
  'onresize',
  'ontouchstart',
  'ontouchend',
  'ontouchmove',
];

function validate(): void {
  if (!existsSync(INDEX_HTML)) {
    console.error(`ERROR: ${INDEX_HTML} does not exist. Build first.`);
    process.exit(1);
  }

  const html = readFileSync(INDEX_HTML, 'utf-8');
  const errors: string[] = [];

  // Check for inline <script> tags (those without src attribute)
  // Match <script> tags and check if they have src
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRegex)) {
    const attrs = match[1] ?? '';
    const content = match[2] ?? '';
    if (!attrs.includes('src=') && content.trim().length > 0) {
      errors.push(`Inline <script> found: ${content.trim().slice(0, 80)}...`);
    }
  }

  // Check for <style> tags
  const styleTagRegex = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
  const styleMatches = html.match(styleTagRegex);
  if (styleMatches) {
    for (const styleMatch of styleMatches) {
      errors.push(`Inline <style> found: ${styleMatch.slice(0, 80)}...`);
    }
  }

  // Check for inline style= attributes
  const inlineStyleRegex = /\bstyle\s*=\s*["'][^"']*["']/gi;
  const styleAttrMatches = html.match(inlineStyleRegex);
  if (styleAttrMatches) {
    for (const attr of styleAttrMatches) {
      errors.push(`Inline style attribute found: ${attr}`);
    }
  }

  // Check for event handler attributes
  for (const handler of EVENT_HANDLER_ATTRS) {
    const handlerRegex = new RegExp(`\\b${handler}\\s*=\\s*["']`, 'gi');
    const handlerMatches = html.match(handlerRegex);
    if (handlerMatches) {
      for (const h of handlerMatches) {
        errors.push(`Event handler attribute found: ${h}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Build validation FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('Build validation passed: zero inline scripts, styles, or event handlers.');
}

validate();
