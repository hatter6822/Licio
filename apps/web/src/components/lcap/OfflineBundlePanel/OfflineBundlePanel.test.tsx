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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBundle, exportDisclosure, gatherRoomExport } from '../../../lcap/bundle-export.js';
import {
  getLcapDb,
  LCAP_DB_VERSION,
  LCAP_MIGRATIONS,
  LCAP_STORE,
  openLcapDb,
  resetLcapDbConnection,
} from '../../../lcap/db.js';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { checkA11y } from '../../../test/axe.js';
import { OfflineBundlePanel } from './OfflineBundlePanel.js';

/** Drop the shared WS-S room store so each private-room case sees ONLY the rooms
 *  it founded. `openPrivateP2pDb` recreates it on next use. */
function deletePrivateP2pDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

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

describe('OfflineBundlePanel — public-room export reachability (offline-page picker)', () => {
  afterEach(() => {
    resetLcapDbConnection();
  });

  it('discovers rooms held offline and a picker drives the export (no room context needed)', async () => {
    // Seed the DEFAULT lcap_v2 with two rooms so the panel's discovery offers them.
    const db = await getLcapDb();
    let n = 0;
    const seed = async (roomHash: string): Promise<void> => {
      const body = new TextEncoder().encode(`r-${roomHash}-${n++}`);
      const recordCid = await cidFor('record', body);
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(LCAP_STORE.records, 'readwrite');
        tx.objectStore(LCAP_STORE.records).put({
          recordCid,
          body,
          kind: 'contribution_event',
          lane: 'T1',
          priority: 1,
          roomHash,
          state: 'integrity_verified',
          size: body.length,
        });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    };
    await seed('a1a1a1a1a1a1a1a1');
    await seed('b2b2b2b2b2b2b2b2');

    render(<OfflineBundlePanel enablePrivateRooms={false} />);
    // The picker appears (no room passed in context); no export section until a room is chosen.
    expect(
      await screen.findByRole('heading', { name: /choose a room to export/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /export this room/i })).not.toBeInTheDocument();

    // Choosing a room reveals the export section + its prepare action.
    await userEvent.click(screen.getAllByRole('radio')[0] as HTMLElement);
    expect(await screen.findByRole('heading', { name: /export this room/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /prepare export/i })).toBeInTheDocument();
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

describe('OfflineBundlePanel — WS-R.16.1 cross-plane private-room bridge', () => {
  afterEach(async () => {
    resetLcapDbConnection();
    // `foundPrivateRoom` persists into the SHARED `licio_private_p2p` database,
    // which lives for the whole test FILE — resetting the LCAP connection does
    // nothing for it. Without this, rooms accumulate across cases and every
    // singular `findByRole` below holds only in declaration order (a shuffle
    // turns the file red on "found multiple elements"), while a regression that
    // rendered only `privateRooms[0]` would pass unnoticed.
    // `openPrivateP2pDb` memoises nothing and every caller closes its handle,
    // so deleting the database is complete isolation with no production hook.
    await deletePrivateP2pDatabase();
  });

  /** Found a REAL device-local private room (the shipped MLS/HPKE/Ed25519 crypto) so the
   *  panel's private export + private import surfaces have something to act on. */
  async function foundPrivateRoom(name: string): Promise<string> {
    const { PrivateRoomSession } = await import('../../../private-p2p/room-manager.js');
    const session = await PrivateRoomSession.create({
      roomName: name,
      roomType: 'global_topic',
      founderMemberId: `member-${Math.random().toString(36).slice(2)}`,
      founderDeviceId: `device-${Math.random().toString(36).slice(2)}`,
    });
    return session.roomId;
  }

  it('offers EVERY device-local private room for export, not just the first', async () => {
    await foundPrivateRoom('Room One');
    await foundPrivateRoom('Room Two');
    render(<OfflineBundlePanel />);
    // The discovery effect resolves async; the private export heading then appears.
    expect(
      await screen.findByRole('heading', { name: /export a private room/i }),
    ).toBeInTheDocument();
    // Multiplicity is the assertion that matters: a singular query holds while
    // exactly one room exists, so it cannot tell "renders every room" from
    // "renders `privateRooms[0]`".
    expect(await screen.findAllByRole('button', { name: /export encrypted file/i })).toHaveLength(
      2,
    );
    expect(screen.getByText('Room One')).toBeInTheDocument();
    expect(screen.getByText('Room Two')).toBeInTheDocument();
  });

  it('hides the private surface when enablePrivateRooms is false', async () => {
    await foundPrivateRoom('Hidden Room');
    // Render with the flag ON first, so the heading is OBSERVED to appear for
    // this room. Otherwise the case passes whenever discovery merely has not
    // resolved yet (a cold room-manager import), i.e. even if the flag is ignored.
    const enabled = render(<OfflineBundlePanel />);
    expect(
      await screen.findByRole('heading', { name: /export a private room/i }),
    ).toBeInTheDocument();
    enabled.unmount();

    render(<OfflineBundlePanel enablePrivateRooms={false} />);
    // The import surface renders synchronously; once it is up, discovery has had
    // its chance and the private heading must still be absent.
    await screen.findByRole('heading', { name: /import an offline bundle/i });
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: /export a private room/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it('routes a contains_private_encrypted bundle to the private engine (not the public store)', async () => {
    // Found a room, author a post, then export it as a private (ciphertext-only) bundle
    // via the REAL cross-plane bridge over the room's stored envelopes.
    const roomId = await foundPrivateRoom('Routed Room');
    const { PrivateRoomSession } = await import('../../../private-p2p/room-manager.js');
    const session = await PrivateRoomSession.load(roomId);
    if (!session) throw new Error('room not found');
    await session.postStory({ title: 'an offline private post' });

    const { IndexedDbPrivateRoomStorage } = await import('../../../private-p2p/storage.js');
    const stored = await new IndexedDbPrivateRoomStorage(roomId).listEnvelopes();
    expect(stored.length).toBeGreaterThan(0);
    const { exportPrivateEnvelopesToBundle } = await import('../../../lcap/cross-plane-bridge.js');
    const { bundleBytes } = await exportPrivateEnvelopesToBundle(stored.map((s) => s.envelope));

    const user = userEvent.setup();
    render(<OfflineBundlePanel />);
    // Wait for the discovery effect so the panel knows a private room exists to route to.
    await screen.findByRole('heading', { name: /export a private room/i });

    const file = new File([bundleBytes as BlobPart], 'private.licio-bundle', {
      type: 'application/vnd.licio.lcap-pack',
    });
    await user.upload(screen.getByLabelText('Choose a bundle file'), file);

    // The public path REFUSED it (private label) and routed it to the private surface:
    // the "Encrypted bundle" target picker appears — NOT the public summary/Import button.
    expect(
      await screen.findByText(/end-to-end-encrypted private room bundle/i),
    ).toBeInTheDocument();
    const target = await screen.findByRole('combobox', { name: /add to private room/i });
    expect(target).toBeInTheDocument();

    // Add it to the chosen room → the private engine re-verifies every envelope.
    await user.click(screen.getByRole('button', { name: /^add to room$/i }));
    await waitFor(
      () => expect(screen.getByText(/encrypted items to the room/i)).toBeInTheDocument(),
      { timeout: 10_000 },
    );
    // The bundle came FROM this room, so the engine's verify-before-use path
    // opens every envelope and finds each op ALREADY held — an exact idempotent
    // re-receive (`existingSig === envelope.signature`), reported in neither the
    // accepted nor the quarantined list.  That is the single most likely thing a
    // person does with a private bundle: restore their own backup.
    //
    // Asserting only `/encrypted items to the room/` could not tell that apart
    // from a total verification failure — both render it — and the panel used to
    // end that same line with "The rest were held back — they do not verify
    // against this room's keys", telling the user their intact backup was
    // corrupt.  So: no held-back line, and the already-present line instead.
    expect(
      screen.queryByText(/were not added \(wrong room keys or malformed\)/i),
    ).not.toBeInTheDocument();
    expect(await screen.findByText(/were already in this room/i)).toBeInTheDocument();
  });
});
