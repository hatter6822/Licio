// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { PrivateRoomDetailPage } from './-pages/private-rooms.js';

export const Route = createFileRoute('/private_/$roomId')({
  component: PrivateRoomDetailPage,
});
