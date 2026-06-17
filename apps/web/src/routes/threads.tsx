// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `/threads` tab is a PUBLIC read surface — like the front-page feed and
// the `/rooms` directory — listing the public conversations across Licio.  The
// server applies the same two-condition global containment as the feed (PUBLIC
// items from PUBLIC rooms; `room_only` and private-room conversations are
// reached through their room), so the set is user-independent and no route-level
// auth gate is needed (one would only wrongly hide public threads from
// logged-out readers).
import { createFileRoute } from '@tanstack/react-router';
import { ThreadsPage } from './-pages/threads.js';

export const Route = createFileRoute('/threads')({
  component: ThreadsPage,
});
