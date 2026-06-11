// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Structural typings for the jsdom globals used by the UGC test files.
// @licio/shared compiles with `lib: ["ES2022"]` (environment-neutral, the
// utils/url.ts precedent), so DOM types are declared locally instead of
// admitting lib.dom into the whole program.

export interface TestElement {
  readonly nodeName: string;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): TestElement | null;
}

export interface TestTemplateElement extends TestElement {
  innerHTML: string;
  readonly content: {
    querySelector(selector: string): TestElement | null;
  };
}

export interface TestTreeWalker {
  nextNode(): TestElement | null;
}

export interface TestDocument {
  createElement(tag: 'template'): TestTemplateElement;
  createTreeWalker(root: unknown, whatToShow: number): TestTreeWalker;
}

export interface TestWindow {
  trustedTypes?: unknown;
}

/** `NodeFilter.SHOW_ELEMENT` (the DOM constant, declared locally). */
export const SHOW_ELEMENT = 0x1;

/** The jsdom `document` global (only valid under @vitest-environment jsdom). */
export function jsdomDocument(): TestDocument {
  return (globalThis as unknown as { document: TestDocument }).document;
}

/** The jsdom `window` global (only valid under @vitest-environment jsdom). */
export function jsdomWindow(): TestWindow {
  return (globalThis as unknown as { window: TestWindow }).window;
}
