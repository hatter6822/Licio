// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the always-available transport catalog mirror: it pins exactly ONE
// non-removable HTTPS server anchor (last in seam order), the public-only posture of
// the peer carriers, and the server-mediated carriers that may carry private content.

import { describe, expect, it } from 'vitest';
import { TRANSPORT_CATALOG } from './transport-catalog.js';

describe('TRANSPORT_CATALOG (§22.6)', () => {
  it('contains exactly one non-removable HTTPS anchor, ordered last', () => {
    const anchors = TRANSPORT_CATALOG.filter((tr) => tr.anchor);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.id).toBe('https');
    expect(anchors[0]?.optional).toBe(false);
    expect(TRANSPORT_CATALOG.at(-1)?.id).toBe('https'); // server anchor last
  });

  it('marks peer carriers public-only and server-mediated carriers private-capable', () => {
    const find = (id: string) => TRANSPORT_CATALOG.find((tr) => tr.id === id);
    expect(find('https')?.serverMediated).toBe(true);
    expect(find('https')?.carriesPrivate).toBe(true);
    expect(find('webrtc')?.serverMediated).toBe(false);
    expect(find('webrtc')?.carriesPrivate).toBe(false);
    expect(find('courier')?.carriesPrivate).toBe(false);
    expect(find('qr')?.carriesPrivate).toBe(false);
  });

  it('every optional carrier is non-anchor', () => {
    for (const tr of TRANSPORT_CATALOG) {
      if (tr.optional) expect(tr.anchor).toBe(false);
    }
  });
});
