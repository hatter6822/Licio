// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J user-facing safety pages: the published support contact (unauthenticated),
// the moderation-notice inbox (statement of reasons + appeal), and the block /
// mute management surface.
import { NoticeInbox } from '../../components/safety/NoticeInbox.js';
import { SafetyRelations } from '../../components/safety/SafetyRelations.js';
import { SupportContact } from '../../components/safety/SupportContact.js';

export function SupportPage(): React.ReactElement {
  return <SupportContact />;
}

export function NoticesPage(): React.ReactElement {
  return <NoticeInbox />;
}

export function RelationsPage(): React.ReactElement {
  return <SafetyRelations />;
}
