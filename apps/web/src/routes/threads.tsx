// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `/threads` tab is a PUBLIC read surface — like the front-page feed and
// the `/rooms` directory — listing the conversations the visitor may see.
// Visibility is enforced server-side on the optional session (public threads to
// everyone; private/restricted-room threads only to members/stewards), so no
// route-level auth gate is needed (and one would wrongly hide public threads
// from logged-out readers).
import { createFileRoute } from '@tanstack/react-router';
import { ThreadsPage } from './-pages/threads.js';

export const Route = createFileRoute('/threads')({
  component: ThreadsPage,
});
