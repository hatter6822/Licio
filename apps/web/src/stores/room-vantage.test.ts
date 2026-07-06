// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { useRoomVantageStore } from './room-vantage.js';

const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';
const LENS_A = '33333333-3333-4333-8333-333333333333';
const LENS_B = '44444444-4444-4444-8444-444444444444';

const uuid = (n: number): string =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

describe('room vantage store (WS-G.2.2 declare-once lens)', () => {
  beforeEach(() => {
    useRoomVantageStore.setState({ byRoom: {} });
    try {
      globalThis.localStorage?.clear();
    } catch {
      // ignore in environments without localStorage
    }
  });

  it('returns null for a room with no declared vantage', () => {
    expect(useRoomVantageStore.getState().getVantage(ROOM_A)).toBeNull();
  });

  it('remembers a declared vantage per room independently', () => {
    const { setVantage, getVantage } = useRoomVantageStore.getState();
    setVantage(ROOM_A, LENS_A);
    setVantage(ROOM_B, LENS_B);
    expect(useRoomVantageStore.getState().getVantage(ROOM_A)).toBe(LENS_A);
    expect(useRoomVantageStore.getState().getVantage(ROOM_B)).toBe(LENS_B);
    // getVantage bound at call time reads current state.
    expect(getVantage(ROOM_A)).toBe(LENS_A);
  });

  it('clears a vantage when set to null', () => {
    useRoomVantageStore.getState().setVantage(ROOM_A, LENS_A);
    useRoomVantageStore.getState().setVantage(ROOM_A, null);
    expect(useRoomVantageStore.getState().getVantage(ROOM_A)).toBeNull();
  });

  it('persists the declared vantage to localStorage', () => {
    useRoomVantageStore.getState().setVantage(ROOM_A, LENS_A);
    const raw = globalThis.localStorage?.getItem('licio:room-vantage');
    expect(raw).toBeTruthy();
    expect(raw).toContain(LENS_A);
  });

  it('bounds the remembered rooms so storage cannot grow without limit', () => {
    const { setVantage } = useRoomVantageStore.getState();
    for (let i = 0; i < 60; i += 1) setVantage(uuid(i), LENS_A);
    expect(Object.keys(useRoomVantageStore.getState().byRoom).length).toBeLessThanOrEqual(50);
  });

  it('evicts the least-recently-SET room, sparing one that was just re-declared (LRU)', () => {
    const { setVantage, getVantage } = useRoomVantageStore.getState();
    for (let i = 0; i < 50; i += 1) setVantage(uuid(i), LENS_A); // rooms 0..49 fill the cap
    setVantage(uuid(0), LENS_B); // re-declare room 0 → it becomes the most recent
    setVantage(uuid(50), LENS_A); // a 51st room forces one eviction
    // Room 0 survives (recently re-declared); the now-oldest (room 1) is evicted.
    expect(getVantage(uuid(0))).toBe(LENS_B);
    expect(getVantage(uuid(1))).toBeNull();
    expect(getVantage(uuid(50))).toBe(LENS_A);
    expect(Object.keys(useRoomVantageStore.getState().byRoom).length).toBe(50);
  });
});
