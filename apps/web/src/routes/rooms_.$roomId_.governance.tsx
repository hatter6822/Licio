// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { RoomGovernancePage } from './-pages/rooms.js';

export const Route = createFileRoute('/rooms_/$roomId_/governance')({
  component: RoomGovernancePage,
});
