// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One clipboard write, one truthful answer.
//
// `await navigator.clipboard?.writeText(x)` looks defensive and is not: optional
// chaining makes the whole expression `undefined` when the API is absent, and
// `await undefined` resolves. Every caller written that way then reported
// "Copied" in exactly the environments where nothing was copied — an insecure
// context, an older WebView, a browser that exposes no `clipboard` at all — and
// the user pastes stale content into a channel they chose deliberately. For an
// invite link or a room id that is a silent data loss, not a cosmetic slip.
//
// So: probe for the METHOD, and return whether the write actually happened. A
// caller that ignores the result gets no worse than before; one that reads it
// cannot claim success that did not occur.

/** Write `text` to the clipboard. Returns false if it did not happen — an
 *  unavailable API and a rejected/denied write are the same answer to the only
 *  question a caller has. */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
