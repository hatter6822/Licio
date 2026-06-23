// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the safety-number (SAS) panel renders the trusted-channel note,
// lists other devices, computes a real safety number for a chosen device (real
// crypto in jsdom), and persists a per-device "verified" toggle in localStorage.
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { checkA11y } from '../../../test/axe.js';
import { SafetyNumberPanel, type VerifiableDevice } from './SafetyNumberPanel.js';

afterEach(async () => {
  globalThis.localStorage?.clear();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

/** Found a room, then admit a second device end-to-end so the room has another
 *  device with a real long-term key to compute a SAS against. */
async function makeRoomWithSecondDevice(): Promise<{
  session: PrivateRoomSession;
  devices: VerifiableDevice[];
}> {
  const session = await PrivateRoomSession.create({
    roomName: 'Quiet Room',
    roomType: 'global_topic',
    founderMemberId: 'me',
    founderDeviceId: 'my-dev',
  });
  const prep = await PrivateRoomSession.prepareJoinRequest({ proposedDisplayName: 'Bob' });
  const { invite, inviteUrl } = await session.createInvite({
    inviteePublicKey: prep.inviteePublicKey,
  });
  const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
  const { request } = await prep.complete(fragment);
  const { verdict } = await session.admitJoinRequest(invite, request);
  expect(verdict.ok).toBe(true);
  const state = session.state();
  const devices: VerifiableDevice[] = [...state.devices.values()]
    .filter((d) => d.deviceId !== session.deviceId)
    .map((d) => ({ deviceId: d.deviceId, memberId: d.memberId }));
  return { session, devices };
}

describe('SafetyNumberPanel', () => {
  it('renders the trusted-channel note and a no-others message when empty', async () => {
    const session = await PrivateRoomSession.create({
      roomName: 'R',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
    });
    render(<SafetyNumberPanel session={session} devices={[]} />);
    expect(screen.getByText(/over a channel you already trust/i)).toBeInTheDocument();
    expect(screen.getByText(/no other devices to verify/i)).toBeInTheDocument();
  });

  it('computes a real safety number for a chosen device and toggles verified', async () => {
    const user = userEvent.setup();
    const { session, devices } = await makeRoomWithSecondDevice();
    expect(devices.length).toBe(1);
    render(<SafetyNumberPanel session={session} devices={devices} />);

    // Selecting the device computes + renders the five-digit groups.
    const [device] = devices;
    if (!device) throw new Error('expected a device');
    await user.click(screen.getByRole('button', { name: new RegExp(device.deviceId.slice(0, 8)) }));
    // The Signal-style SAS is an async iterated hash; under full-suite CPU load it can take
    // >1s, so allow a generous timeout (the default 1s flaked intermittently).
    await waitFor(
      () => expect(screen.getByLabelText(/safety number digits/i)).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );
    const groups = screen.getByLabelText(/safety number digits/i);
    // 12 five-digit groups (60 digits).
    expect(groups.querySelectorAll('span').length).toBe(12);

    // The verified toggle persists to localStorage keyed by room + device.
    const toggle = screen.getByLabelText(/verified out-of-band/i);
    await user.click(toggle);
    await waitFor(() => {
      const raw = globalThis.localStorage.getItem(
        `licio.private-p2p.verified-devices.${session.roomId}`,
      );
      expect(raw).toContain(device.deviceId);
    });
  });

  it('has no accessibility violations', async () => {
    const session = await PrivateRoomSession.create({
      roomName: 'R',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
    });
    const { container } = render(<SafetyNumberPanel session={session} devices={[]} />);
    await checkA11y(container);
  });
});
