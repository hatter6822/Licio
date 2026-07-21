// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DEV-ONLY debate fast-forward control (WS-T). Jumps a debate to its next
// lifecycle milestone through the simulator control surface, so a real
// spec-window (24h) arena can be watched end-to-end on demand. This module is
// loaded ONLY behind the DebateArena's `import.meta.env.DEV` lazy gate — it
// never enters a production bundle.
import { useState } from 'react';
import { fastForwardDebate } from '../../lib/dev-simulator-api.js';
import { Badge } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';

export default function DevFastForward({ debateId }: { debateId: string }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const jump = async (to: 'locked' | 'verdict' | 'resolved'): Promise<void> => {
    setBusy(true);
    try {
      await fastForwardDebate(debateId, { to });
    } catch {
      // Dev-only convenience; the arena poll/stream reflects whatever happened.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="group" className="flex flex-wrap items-center gap-2" aria-label="Dev fast-forward">
      <Badge tone="warning">dev</Badge>
      <span className="text-sm text-ink-muted">Fast-forward:</span>
      {(['locked', 'verdict', 'resolved'] as const).map((to) => (
        <Button
          key={to}
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => void jump(to)}
        >
          {to}
        </Button>
      ))}
    </div>
  );
}
