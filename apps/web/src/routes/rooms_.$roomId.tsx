// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { roomDetailSearchSchema } from '../routing/search.js';
import { RoomDetailPage } from './-pages/rooms.js';

export const Route = createFileRoute('/rooms_/$roomId')({
  // `?governance=<tab>` deep-links the room-governance modal open (WS-U §24.6).
  validateSearch: roomDetailSearchSchema,
  component: RoomDetailPage,
});
