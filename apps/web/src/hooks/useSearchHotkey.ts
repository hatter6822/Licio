// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Global Ctrl/Cmd+K → toggle the public-content search modal (WS-F.3.1b).
// Mounted once in the root layout. The primary modifier follows the platform
// (⌘ on Apple devices, Ctrl elsewhere — the MarkdownEditor shortcut
// convention); the browser default for the chord (address-bar focus) is
// suppressed only when the chord matches exactly.
import { useEffect } from 'react';
import { useUIStore } from '../stores/index.js';

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform ?? navigator.userAgent);
}

export function useSearchHotkey(): void {
  const toggleSearch = useUIStore((state) => state.toggleSearch);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const primaryHeld = isApplePlatform() ? event.metaKey : event.ctrlKey;
      if (!primaryHeld || event.shiftKey || event.altKey) return;
      if (event.key !== 'k' && event.key !== 'K') return;
      event.preventDefault();
      toggleSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSearch]);
}
