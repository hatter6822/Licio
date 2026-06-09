// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A shareable branch path canonicalises to the thread with the branch selected.
import { branchIdSchema } from '@licio/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/threads_/$threadId_/branches/$branchId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      // `to` resolves against the URL fullPath (the `_` non-nesting marker is a
      // route-id concept only); `from` in useParams/useSearch uses the id form.
      to: '/threads/$threadId',
      params: { threadId: params.threadId },
      // Coerce an unknown branch in the path to the default (never silently accepted).
      search: { branch: branchIdSchema.catch('overview').parse(params.branchId) },
    });
  },
});
