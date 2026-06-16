// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 moderation console page (steward workspace).  Authorization is enforced
// server-side; a non-steward sees an access notice rather than data.
import { ModerationConsole } from '../../components/moderation/ModerationConsole.js';

export function ModerationConsolePage(): React.ReactElement {
  return <ModerationConsole />;
}
