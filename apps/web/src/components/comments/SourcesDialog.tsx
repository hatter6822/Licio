// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T sourced comments — the "Sources" footnote modal.  A comment's sources are
// the INLINE links in its body (each a sourced statement); this dialog lists them
// as a numbered footnote apparatus — the sourced statement + its efficiently
// expanded source URL — reached from the compact "Sources (N)" action next to
// Reply/Correct/Report.  Legacy comments (bare citations with no matching body
// link) are merged in by `resolveCommentSources`.  Strictly no-applause: a
// source is a content/evidence signal, never a popularity count.
import { type CommentItem, resolveCommentSources } from '@licio/shared';
import { formatSourceUrl } from '../../lib/format-source-url.js';
import { SafeExternalLink } from '../ugc/SafeExternalLink.js';
import { Dialog } from '../ui/Dialog/index.js';

export function SourcesDialog({
  open,
  onClose,
  comment,
}: {
  open: boolean;
  onClose: () => void;
  comment: CommentItem;
}): React.ReactElement | null {
  if (!open) return null;
  const sources = resolveCommentSources(comment.body, comment.citations);
  return (
    <Dialog open={open} onClose={onClose} title="Sources">
      {sources.length === 0 ? (
        <p className="text-sm text-ink-muted">This comment has no attached sources.</p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Sources cited in this comment">
          {sources.map((source, index) => {
            const { host, rest } = formatSourceUrl(source.url);
            return (
              <li key={source.url} className="flex items-start gap-2 text-sm">
                <span
                  className="mt-px shrink-0 tabular-nums font-medium text-ink-muted"
                  aria-hidden
                >
                  {index + 1}.
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-ink">{source.statement}</span>
                  <SafeExternalLink
                    href={source.url}
                    className="inline-flex flex-wrap items-baseline gap-x-1 break-words text-primary-on-soft hover:underline"
                  >
                    <span className="font-medium">{host}</span>
                    {rest ? <span className="text-ink-muted">{rest}</span> : null}
                  </SafeExternalLink>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Dialog>
  );
}
