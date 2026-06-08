// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Context Card (WS-B.2.4a layout, WS-B.2.4b interaction). The seven-section
// explanation of a story, rendered INSIDE the shared Sheet — so the Sheet owns
// the dialog semantics, focus trap, scroll-lock, focus-return-to-trigger and the
// Escape / swipe-down dismiss; this component only lays out the content.
//
// Doctrine guardrails baked in:
//   • No applause affordances anywhere (no like / vote / score control).
//   • "Distribution reason" is human-readable prose, never a numeric score.
//   • "Signal problem" routes to a report flow via `onReport` — never a public
//     downvote.
//
// A11y: each section is a native <details open> (keyboard- and Biome-friendly
// collapsible) inside a labelled region, with an <h2> heading. A non-swipe
// section navigator (prev/next Buttons, WCAG 2.5.1) moves focus between the
// section headings; the Sheet's own swipe-down handles dismissal.
import { type ReactElement, type ReactNode, useId, useRef } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { Sheet } from '../../ui/Sheet/index.js';
import { RatingLabel } from '../RatingLabel/index.js';
import type { ContextCardData } from './types.js';

export interface ContextCardProps {
  open: boolean;
  onClose: () => void;
  data: ContextCardData;
  /** Override the Sheet's accessible name. */
  title?: string;
  className?: string;
}

/** Reject a distribution reason that leaks a raw numeric score (dev-only). */
function warnIfScoreLike(reason: string): void {
  if (!import.meta.env.DEV) return;
  if (/\b\d+(?:\.\d+)?\s*(?:points?|pts?|score|rank(?:ed)?|%)\b/i.test(reason)) {
    console.warn(
      `ContextCard: distributionReason looks like a raw score ("${reason}"). It must be human-readable and never expose a numeric score (no-applause doctrine).`,
    );
  }
}

export function ContextCard({
  open,
  onClose,
  data,
  title,
  className,
}: ContextCardProps): ReactElement {
  const t = useT();
  const baseId = useId();
  // One focusable handle per section heading for prev/next navigation.
  const headingRefs = useRef<(HTMLHeadingElement | null)[]>([]);

  warnIfScoreLike(data.distributionReason);

  const sheetTitle = title ?? t('context.title', 'Context');

  // The seven sections IN ORDER (WS-B.2.4a). `key` is the stable section id;
  // `heading` is the <h2> text; `body` is the section content.
  const sections: { key: string; heading: string; body: ReactNode }[] = [
    {
      key: 'what-happened',
      heading: t('context.whatHappened', 'What happened'),
      body: <div className="text-base text-ink">{data.whatHappened}</div>,
    },
    {
      key: 'why-it-matters',
      heading: t('context.whyItMatters', 'Why it matters'),
      body: <div className="text-base text-ink">{data.whyItMatters}</div>,
    },
    {
      key: 'interpretations',
      heading: t('context.interpretations', 'Where interpretations differ'),
      body:
        data.interpretations.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {data.interpretations.map((item, index) => (
              <li
                // Perspective labels can repeat across communities; pair with the
                // index for a stable key without assuming uniqueness.
                key={`${item.perspective}-${index}`}
                className="border-line border-s-2 ps-3"
              >
                <p className="font-medium text-ink text-sm">{item.perspective}</p>
                <div className="text-base text-ink-muted">{item.summary}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-base text-ink-muted">
            {t('context.interpretations.none', 'No differing interpretations recorded yet.')}
          </p>
        ),
    },
    {
      key: 'evidence-status',
      heading: t('context.evidenceStatus', 'Evidence status'),
      body: <div className="text-base text-ink">{data.evidenceStatus}</div>,
    },
    {
      key: 'conversation-state',
      heading: t('context.conversationState', 'Conversation state'),
      body: (
        <div className="flex flex-col gap-2">
          {data.conversationState.ratingLabel ? (
            <div>
              <RatingLabel kind={data.conversationState.ratingLabel} />
            </div>
          ) : null}
          {data.conversationState.detail ? (
            <div className="text-base text-ink">{data.conversationState.detail}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'distribution-reason',
      heading: t('context.distributionReason', 'Distribution reason'),
      // Human-readable prose ONLY — never a raw numeric score.
      body: <p className="text-base text-ink">{data.distributionReason}</p>,
    },
    {
      key: 'user-controls',
      heading: t('context.userControls', 'Your controls'),
      body: (
        <div className="flex flex-wrap gap-2">
          {data.onSeeLess ? (
            <Button variant="secondary" onClick={data.onSeeLess}>
              <Icon name="minus" className="size-4" />
              {t('context.seeLess', 'See less')}
            </Button>
          ) : null}
          {data.onSeeMore ? (
            <Button variant="secondary" onClick={data.onSeeMore}>
              <Icon name="plus" className="size-4" />
              {t('context.seeMore', 'See more')}
            </Button>
          ) : null}
          {data.onMuteTopic ? (
            <Button variant="secondary" onClick={data.onMuteTopic}>
              <Icon name="volume-x" className="size-4" />
              {t('context.muteTopic', 'Mute topic')}
            </Button>
          ) : null}
          {data.onInspectSignals ? (
            <Button variant="secondary" onClick={data.onInspectSignals}>
              <Icon name="sliders" className="size-4" />
              {t('context.inspectSignals', 'Inspect ranking signals')}
            </Button>
          ) : null}
          {/* "Signal problem" routes to the report flow — never a downvote. */}
          {data.onReport ? (
            <Button variant="secondary" onClick={data.onReport}>
              <Icon name="flag" className="size-4" />
              {t('context.report', 'Signal problem')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const sectionHeadingId = (key: string): string => `${baseId}-${key}-heading`;

  // Non-swipe section navigation (WCAG 2.5.1): move focus to a section heading.
  const focusSection = (index: number): void => {
    const clamped = Math.max(0, Math.min(sections.length - 1, index));
    const target = headingRefs.current[clamped];
    target?.focus();
    // `scrollIntoView` is a progressive enhancement (and absent under jsdom).
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <Sheet open={open} onClose={onClose} title={sheetTitle} className={cn(className)}>
      {/* Section navigator: a prev/next pager that is the keyboard- and
          single-pointer alternative to any horizontal swipe between sections. */}
      <nav
        aria-label={t('context.nav.label', 'Context sections')}
        className="mb-4 flex items-center justify-between gap-2"
      >
        <Button
          variant="ghost"
          onClick={() => focusSection(0)}
          aria-label={t('context.nav.first', 'Go to the first section')}
        >
          <Icon name="chevron-left" className="size-4" />
          {t('context.nav.start', 'Start')}
        </Button>
        <span className="text-ink-muted text-xs">
          {t('context.nav.count', '{count} sections', { count: sections.length })}
        </span>
        <Button
          variant="ghost"
          onClick={() => focusSection(sections.length - 1)}
          aria-label={t('context.nav.last', 'Go to the last section')}
        >
          {t('context.nav.end', 'Controls')}
          <Icon name="chevron-right" className="size-4" />
        </Button>
      </nav>

      <div className="flex flex-col gap-3">
        {sections.map((section, index) => (
          <section
            key={section.key}
            aria-labelledby={sectionHeadingId(section.key)}
            className="rounded-md border border-line"
          >
            {/* Native collapsible: accessible + Biome-friendly, open by default
                so the whole explanation is readable without interaction. */}
            <details open className="group">
              <summary
                className={cn(
                  'flex min-h-touch cursor-pointer list-none items-center justify-between gap-2 px-3 py-2',
                  'rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  'hover:bg-surface',
                )}
              >
                <h2
                  id={sectionHeadingId(section.key)}
                  ref={(node) => {
                    headingRefs.current[index] = node;
                  }}
                  tabIndex={-1}
                  className="font-semibold text-base text-ink focus-visible:outline-none"
                >
                  {section.heading}
                </h2>
                <Icon
                  name="chevron-down"
                  className="size-4 text-ink-muted transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="px-3 pt-1 pb-3">{section.body}</div>
            </details>

            {/* Per-section pager (the non-swipe forward/back alternative). */}
            <div className="flex items-center justify-between gap-2 px-3 pb-2">
              <Button
                variant="ghost"
                disabled={index === 0}
                onClick={() => focusSection(index - 1)}
                aria-label={t('context.nav.prev', 'Previous section')}
              >
                <Icon name="chevron-left" className="size-4" />
                {t('context.nav.previous', 'Previous')}
              </Button>
              <Button
                variant="ghost"
                disabled={index === sections.length - 1}
                onClick={() => focusSection(index + 1)}
                aria-label={t('context.nav.next', 'Next section')}
              >
                {t('context.nav.nextLabel', 'Next')}
                <Icon name="chevron-right" className="size-4" />
              </Button>
            </div>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
