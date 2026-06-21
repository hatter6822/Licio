// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.1 — the §34 honest trust badge: every one of the 13 states renders its own
// distinct label (no collapse), icon + text always pair (never colour alone), the
// copy never uses a forbidden trust word (secure/trusted/delivered/final/safe), and
// the badges pass the accessibility audit.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  LcapLivenessState,
  LcapTrustState,
  TrustLabelKey,
} from '../../../lcap/trust-labels.js';
import { checkA11y } from '../../../test/axe.js';
import { TrustBadge, trustBadgeDescriptors } from './TrustBadge.js';

// A representative (trust, liveness) pair that produces each honest label.
const CASES: ReadonlyArray<readonly [TrustLabelKey, LcapTrustState, LcapLivenessState]> = [
  ['saved_on_device', 'authorized_provisional', 'local_created'],
  ['queued_for_sync', 'authorized_provisional', 'queued'],
  ['shared_in_export', 'authorized_provisional', 'exported'],
  ['stored_by_relay', 'authorized_provisional', 'relay_stored'],
  ['received_by_server', 'authorized_provisional', 'server_stored'],
  ['accepted_by_room', 'authorized_provisional', 'server_accepted'],
  ['included_in_checkpoint', 'authorized_provisional', 'checkpointed'],
  ['witnessed_by_watcher', 'authorized_provisional', 'witnessed'],
  ['verified_local_stale_checkpoint', 'stale_authorized', 'local_created'],
  ['cannot_verify_missing_key', 'integrity_verified', 'local_created'],
  ['conflict_detected', 'conflicting', 'local_created'],
  ['revoked', 'revoked', 'local_created'],
  ['rejected_by_room', 'rejected', 'local_created'],
];

const FORBIDDEN = /\b(secure|trusted|delivered|final|safe)\b/i;

describe('TrustBadge', () => {
  it('renders the distinct honest label for each of the 13 states', () => {
    const { container } = render(
      <div>
        {CASES.map(([key, trust, liveness]) => (
          <TrustBadge key={key} trust={trust} liveness={liveness} />
        ))}
      </div>,
    );
    const texts = CASES.map(([key]) => trustBadgeDescriptors[key].defaultText);
    expect(new Set(texts).size).toBe(CASES.length); // every label distinct — no collapse
    for (const text of texts) expect(screen.getByText(text)).toBeInTheDocument();
    // Icon + text pair on every badge.
    expect(container.querySelectorAll('svg')).toHaveLength(CASES.length);
  });

  it('produces the exact §34 wording the card specifies', () => {
    expect(trustBadgeDescriptors.saved_on_device.defaultText).toBe('Saved on this device');
    expect(trustBadgeDescriptors.accepted_by_room.defaultText).toBe('Accepted by room');
    expect(trustBadgeDescriptors.witnessed_by_watcher.defaultText).toBe(
      'Witnessed by independent watcher',
    );
    expect(trustBadgeDescriptors.rejected_by_room.defaultText).toBe('Rejected by room policy');
  });

  it('never uses a forbidden trust word in any label', () => {
    for (const descriptor of Object.values(trustBadgeDescriptors)) {
      expect(FORBIDDEN.test(descriptor.defaultText)).toBe(false);
    }
  });

  it('passes the accessibility audit for every state', async () => {
    const { container } = render(
      <div>
        {CASES.map(([key, trust, liveness]) => (
          <TrustBadge key={key} trust={trust} liveness={liveness} />
        ))}
      </div>,
    );
    await checkA11y(container);
  });
});
