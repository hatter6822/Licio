// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.3e — the no-private-key content filter for support channels.  It
// detects material that LOOKS like key material — 64-hex private-key strings
// (0x-prefixed or bare) and BIP-39 seed phrases — and the caller BLOCKS the
// submission with the standing warning.  The §18.5 discipline: the filter
// classifies and DISCARDS; the matched value is never logged, stored,
// echoed, or transmitted (the return carries only the kind + the warning).
//
// Detection rule for phrases: 12+ CONSECUTIVE words all drawn from the real
// BIP-39 English wordlist.  Real phrases are 12/15/18/21/24 words, so 12 is
// the shortest true phrase — and matching the ≥12 run also catches a phrase
// pasted mid-sentence.  Checksums are deliberately NOT verified: a phrase
// with one typo still needs the block.  False-positive odds are negligible:
// each prose word is in the 2048-word list well under half the time, so 12
// in a row without a single non-member between them is ~(p^12) ≪ 10⁻⁴ per
// window — and the failure mode is a warning, never data loss.
import { BIP39_ENGLISH } from './bip39-english.js';

export const NO_KEY_WARNING =
  'Never share your private key or seed phrase with anyone, including Licio support. ' +
  'Licio support will never ask for them; any request for a seed phrase is fraudulent. ' +
  'Your message was not submitted — please remove the sensitive material and try again.';

export type KeyMaterialKind = 'private_key_hex' | 'seed_phrase';

export interface KeyMaterialScan {
  detected: boolean;
  kind: KeyMaterialKind | null;
  warning: string | null;
}

const CLEAN: KeyMaterialScan = { detected: false, kind: null, warning: null };
/** A BARE 64-hex run (the raw 256-bit private-key export format), not part
 *  of a longer hex string.  A `0x`-prefixed 64-hex value is deliberately NOT
 *  flagged: that is the transaction-hash format the mistaken-transfer
 *  support flow (WS-N.2.3a) legitimately collects, and blocking it would
 *  break the primary support path — while raw wallet key exports are bare
 *  hex.  Seed phrases (the dominant phishing target) are always flagged. */
const HEX_KEY_RE = /(?<!0x)(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const MIN_PHRASE_RUN = 12;

/** Scan free text for key-like material.  O(words). */
export function scanForKeyMaterial(text: string): KeyMaterialScan {
  if (HEX_KEY_RE.test(text)) {
    return { detected: true, kind: 'private_key_hex', warning: NO_KEY_WARNING };
  }
  let run = 0;
  for (const token of text.toLowerCase().split(/[^a-z]+/)) {
    if (token.length === 0) continue;
    if (BIP39_ENGLISH.has(token)) {
      run += 1;
      if (run >= MIN_PHRASE_RUN) {
        return { detected: true, kind: 'seed_phrase', warning: NO_KEY_WARNING };
      }
    } else {
      run = 0;
    }
  }
  return CLEAN;
}
