// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The DEVELOPMENT traffic-simulator page. The panel drives a dev-only API
// surface; in a production build `import.meta.env.DEV` is false and this page
// renders nothing (the panel component and its client are tree-shaken out).

import { SimulatorPanel } from '../../components/dev/SimulatorPanel.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';

export function DevSimulatorPage(): React.ReactElement {
  if (!import.meta.env.DEV) {
    return (
      <>
        <PageHeader title="Not available" />
        <p className="p-4 text-sm text-ink-muted">
          The traffic simulator is a development-only tool.
        </p>
      </>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <PageHeader title="Traffic simulator" />
      <p className="text-sm text-ink-muted">
        Continuous, deterministic synthetic activity through the real pipelines — new stories, live
        discussion, reading signals, and reports — so you can watch how the feed reacts. Pick a
        scenario and speed; refocus the front page (or open a story) in another tab to see the
        effects. Development only.
      </p>
      <SimulatorPanel />
    </div>
  );
}
