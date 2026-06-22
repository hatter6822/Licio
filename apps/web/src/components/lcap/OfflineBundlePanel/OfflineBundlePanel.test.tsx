// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1a/b — the offline-bundle surface renders accessibly: the import side is
// always present (a labelled file picker); the export side appears only with a room in
// context and shows the §26.2 disclosure heading wording.  The deep export/import logic
// (round-trip, rejection, quarantine) is covered by `lcap/bundle.test.ts`.  The last
// case (WS-R.17.1) drives a REAL bundle import to its done state and asserts the honest
// §34 integrity-only trust badge renders for the records it imported.
import 'fake-indexeddb/auto';
import { cidFor } from '@licio/lcap';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBundle, exportDisclosure, gatherRoomExport } from '../../../lcap/bundle-export.js';
import {
  LCAP_DB_VERSION,
  LCAP_MIGRATIONS,
  LCAP_STORE,
  openLcapDb,
  resetLcapDbConnection,
} from '../../../lcap/db.js';
import { checkA11y } from '../../../test/axe.js';
import { OfflineBundlePanel } from './OfflineBundlePanel.js';

describe('OfflineBundlePanel', () => {
  it('always offers the import file picker, room or not', () => {
    render(<OfflineBundlePanel />);
    expect(screen.getByLabelText('Choose a bundle file')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /import an offline bundle/i })).toBeInTheDocument();
    // No room → no export section.
    expect(screen.queryByRole('heading', { name: /export this room/i })).not.toBeInTheDocument();
  });

  it('shows the export section (with the prepare action) when a room is in context', () => {
    render(<OfflineBundlePanel roomHash="room-abc" roomLabel="My Room" />);
    expect(screen.getByRole('heading', { name: /export this room/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /prepare export/i })).toBeInTheDocument();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<OfflineBundlePanel roomHash="room-abc" />);
    await checkA11y(container);
  });
});

describe('OfflineBundlePanel — import to done (WS-R.17.1 honest trust badge)', () => {
  afterEach(() => {
    resetLcapDbConnection();
  });

  it('renders the integrity-only trust badge for the records it just imported', async () => {
    // Build a REAL .licio-bundle from a throwaway store: one record + its proof in room-A.
    const src = await openLcapDb(
      `lcap_v2-panel-src-${Math.random().toString(36).slice(2)}`,
      LCAP_DB_VERSION,
      LCAP_MIGRATIONS,
    );
    const body = new TextEncoder().encode('a post to hand offline');
    const recordCid = await cidFor('record', body);
    const proofBody = new TextEncoder().encode('proof:a post to hand offline');
    const proofCid = await cidFor('proof', proofBody);
    await new Promise<void>((res, rej) => {
      const tx = src.transaction([LCAP_STORE.records, LCAP_STORE.proofs], 'readwrite');
      tx.objectStore(LCAP_STORE.records).put({
        recordCid,
        body,
        kind: 'contribution_event',
        lane: 'T1',
        priority: 1,
        roomHash: 'room-A',
        state: 'proof_verified',
        size: body.length,
      });
      tx.objectStore(LCAP_STORE.proofs).put({
        proofCid,
        proofBody,
        recordCid,
        signerKeyId: 'device-1',
        verificationState: 'verified',
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    const exportData = await gatherRoomExport(src, 'room-A');
    const disclosure = await exportDisclosure(exportData.items);
    const bundle = await buildBundle({ objects: exportData.objects, disclosure });
    src.close();

    // The panel imports into the (empty) default lcap_v2 connection, so the records
    // commit FRESH at integrity-only trust (not `already_have`) → the done badge renders.
    resetLcapDbConnection();
    const user = userEvent.setup();
    render(<OfflineBundlePanel />);
    const file = new File([bundle as BlobPart], 'room-A.licio-bundle', {
      type: 'application/vnd.licio.lcap-pack',
    });
    await user.upload(screen.getByLabelText('Choose a bundle file'), file);

    // The pre-render summary → confirm the import.
    await user.click(await screen.findByRole('button', { name: /^import$/i }));

    // The done view states the count AND shows the honest §34 integrity-only label —
    // never a claim the trust projection has not granted (WS-R.8.3 / §34).
    expect(await screen.findByText(/cannot verify yet/i)).toBeInTheDocument();
    expect(screen.getByText(/imported 1 posts and 1 proofs/i)).toBeInTheDocument();
  });
});
