// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — `check:private-bundle-transparency` (PRIVATE_SPEC §20.6/§27.5).
// The private-mode bundle loads NO dynamic remote code (eval / new Function /
// importScripts / a dynamic import() of a remote URL): the half enforceable
// before the WS-S.10 update channel ships.  WS-S.10.2b EXTENDS this gate to
// also assert the service-worker pin + the room-lock-on-unverified path once
// the reproducible signed bundle + transparency log exist.
import { privateTreeFiles, reportGate, scanDynamicRemoteCode } from './private-p2p-gates.js';

reportGate('check:private-bundle-transparency', scanDynamicRemoteCode(privateTreeFiles()));
