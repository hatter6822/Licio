// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7 — the apps/web entry point that loads a `PrivateRoomEngine` for a room.
// `@licio/private-p2p` (MLS/HPKE/AEAD/Ed25519 crypto + the reducer + the sync
// cores + the engine) is heavy and off the synchronous path, so it is pulled in
// by a DYNAMIC `import()` ONLY (a lazy chunk — `check:private-p2p-split` forbids a
// static value import in apps/web), keeping the protocol/crypto core out of the
// initial bundle.  The engine is wired to the IndexedDB storage adapter; the UI
// then drives `applyLocalOp` / `ingest` / `state` on the returned engine.

import type { PrivateRoomEngine, PrivateRoomEngineParams } from '@licio/private-p2p';
import { IndexedDbPrivateRoomStorage } from './storage.js';

/** Engine params minus the storage port (this module supplies the IndexedDB one). */
export type LoadPrivateRoomParams = Omit<PrivateRoomEngineParams, 'storage'>;

/**
 * Lazily load `@licio/private-p2p` (code-split) and construct a `PrivateRoomEngine`
 * over the IndexedDB storage for `params.roomId`.  `load` re-verifies every stored
 * envelope before it contributes to state (§8.3 — storage confers no trust).
 */
export async function loadPrivateRoomEngine(
  params: LoadPrivateRoomParams,
): Promise<PrivateRoomEngine> {
  const mod = await import('@licio/private-p2p');
  return mod.PrivateRoomEngine.load({
    ...params,
    storage: new IndexedDbPrivateRoomStorage(params.roomId),
  });
}
