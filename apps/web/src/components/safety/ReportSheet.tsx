// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.1c two-tap report flow.  A bottom sheet lists the taxonomy reasons
// grouped by category; tapping a reason submits the report (≤3 taps: open →
// reason, with an optional context field as the only extra tap).  Offline, the
// report is queued (background sync) and submitted on reconnect; the same
// `local_operation_id` makes the eventual submit idempotent (WS-J.1.1a).  The
// flow is keyboard-operable and screen-reader-labelled (WCAG 2.2 AA).
import type { CreateReportRequest, ReportContentKind, ReportTargetType } from '@licio/shared';
import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { submitReport } from '../../lib/safety-api.js';
import { enqueue } from '../../offline/queue.js';
import { Button } from '../ui/Button/index.js';
import { Icon } from '../ui/Icon/index.js';
import { Sheet } from '../ui/Sheet/index.js';
import { TextArea } from '../ui/TextArea/index.js';
import { useToast } from '../ui/Toast/index.js';
import { Tooltip, type TooltipPlacement } from '../ui/Tooltip/index.js';
import { REPORT_REASON_GROUPS } from './report-reasons.js';

export interface ReportSheetProps {
  open: boolean;
  onClose: () => void;
  targetType: ReportTargetType;
  targetId: string;
  contentKind?: ReportContentKind;
}

export function ReportSheet({
  open,
  onClose,
  targetType,
  targetId,
  contentKind,
}: ReportSheetProps): React.ReactElement | null {
  const t = useT();
  const { toast } = useToast();
  const [context, setContext] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null);

  async function report(reasonCode: CreateReportRequest['reason_code']): Promise<void> {
    setSubmitting(reasonCode);
    const payload: CreateReportRequest = {
      target_type: targetType,
      target_id: targetId,
      ...(contentKind ? { content_kind: contentKind } : {}),
      reason_code: reasonCode,
      ...(context.trim() ? { context: context.trim().slice(0, 500) } : {}),
      local_operation_id: crypto.randomUUID(),
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        await enqueue('report', payload);
        toast({
          message: t('report.queued', 'Report queued — it will be sent when you reconnect.'),
          tone: 'info',
        });
      } else {
        await submitReport(payload);
        toast({
          message: t('report.submitted', 'Report submitted. We will review it.'),
          tone: 'success',
        });
      }
    } catch (error) {
      // A non-4xx failure (offline/transient) falls back to the durable queue.
      const terminal =
        error instanceof ApiClientError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500;
      if (!terminal) {
        await enqueue('report', payload);
        toast({
          message: t('report.queued', 'Report queued — it will be sent when you reconnect.'),
          tone: 'info',
        });
      } else {
        toast({ message: t('report.failed', 'We could not submit that report.'), tone: 'error' });
      }
    } finally {
      setSubmitting(null);
      setContext('');
      onClose();
    }
  }

  if (!open) return null;
  return (
    <Sheet open={open} onClose={onClose} title={t('report.title', 'Report')}>
      <p className="mb-3 text-sm text-ink-muted">
        {t('report.subtitle', 'Choose what best describes the problem. Reports are confidential.')}
      </p>
      <div className="flex flex-col gap-4">
        {REPORT_REASON_GROUPS.map((group) => (
          <section key={group.group} aria-label={group.title}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {group.title}
            </h3>
            <ul className="flex flex-col gap-1">
              {group.reasons.map((reason) => (
                <li key={reason.code}>
                  <Button
                    variant="ghost"
                    className="w-full justify-start text-start"
                    loading={submitting === reason.code}
                    disabled={submitting !== null}
                    onClick={() => void report(reason.code)}
                  >
                    <span className="flex flex-col">
                      <span className="font-medium text-ink">{reason.label}</span>
                      <span className="text-xs text-ink-muted">{reason.description}</span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="mt-4">
        <TextArea
          label={t('report.context.label', 'Add context (optional)')}
          value={context}
          onChange={(e) => setContext(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder={t(
            'report.context.placeholder',
            'Anything that helps us understand the problem.',
          )}
        />
      </div>
    </Sheet>
  );
}

export interface ReportButtonProps {
  targetType: ReportTargetType;
  targetId: string;
  contentKind?: ReportContentKind;
  /** Compact presentation: the flag glyph alone, named for assistive tech and
   *  labelled on hover/focus by a tooltip (WCAG 1.4.13). */
  iconOnly?: boolean;
  /** Override the control's name, so a compact row can say WHAT is reported
   *  ("Report this story") where the text button just says "Report". */
  label?: string;
  /** Inline alignment of the icon-only tooltip. Pass `end` when the control
   *  sits at the inline-end of a row, where a centred bubble would overhang
   *  the viewport edge. */
  tooltipPlacement?: TooltipPlacement;
  className?: string;
}

/** An accessible "Report" affordance that opens the two-tap sheet. */
export function ReportButton({
  targetType,
  targetId,
  contentKind,
  iconOnly = false,
  label,
  tooltipPlacement = 'center',
  className,
}: ReportButtonProps): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const name = label ?? t('report.action', 'Report');
  return (
    <>
      {iconOnly ? (
        <Tooltip content={name} placement={tooltipPlacement}>
          <Button
            iconOnly
            variant="ghost"
            aria-label={name}
            {...(className ? { className } : {})}
            onClick={() => setOpen(true)}
          >
            <Icon name="flag" className="size-5" />
          </Button>
        </Tooltip>
      ) : (
        <Button variant="ghost" {...(className ? { className } : {})} onClick={() => setOpen(true)}>
          {name}
        </Button>
      )}
      {/* Mount the sheet lazily so the closed affordance needs no ToastProvider
          (the sheet's hooks run only once it is actually opened). */}
      {open ? (
        <ReportSheet
          open
          onClose={() => setOpen(false)}
          targetType={targetType}
          targetId={targetId}
          {...(contentKind ? { contentKind } : {})}
        />
      ) : null}
    </>
  );
}
