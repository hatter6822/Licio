// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data-rights controls for the privacy page (WS-D.2): a real DSAR export flow
// (request → poll → step-up-gated download of the decrypted archive), real
// attention-history deletion, and account deletion with its 30-day grace
// period.  These call the live /v1/privacy endpoints — the §19.3 promise is
// that the controls take effect, not placebo toggles.  Deleting the account
// revokes every session server-side, so on success the client signs out too.
import { useState } from 'react';
import { StepUpDialog, useStepUpGate } from '../../components/security/StepUpDialog/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { Dialog } from '../../components/ui/Dialog/index.js';
import { useToast } from '../../components/ui/Toast/index.js';
import { formatDate } from '../../i18n/format.js';
import { useI18n, useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import { StepUpRequiredError } from '../../lib/auth-api.js';
import {
  deleteAttentionHistory,
  downloadExport,
  requestAccountDeletion,
  requestExport,
  saveBlob,
} from '../../lib/privacy-api.js';
import { useExportStatusQuery } from '../../lib/queries.js';
import { useAuthStore } from '../../stores/auth.js';

type Translate = ReturnType<typeof useT>;

function failureMessage(error: unknown, t: Translate): string {
  if (error instanceof StepUpRequiredError) {
    return t('privacy.error.stepUpCancelled', 'Confirmation was cancelled.');
  }
  if (error instanceof ApiClientError) return error.message;
  return t('privacy.error.generic', 'Something went wrong. Please try again.');
}

const EXPORT_STATE_LABELS: Record<string, string> = {
  queued: 'Queued…',
  processing: 'Preparing your archive…',
  completed: 'Ready to download',
  failed: 'Export failed — request it again',
  expired: 'Download window expired — request it again',
};

/** "Your data" controls: export + attention-history deletion. */
export function DataRightsSection(): React.ReactElement {
  const t = useT();
  const { locale } = useI18n();
  const { toast } = useToast();
  const gate = useStepUpGate();
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirmingAttention, setConfirmingAttention] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exportStatus = useExportStatusQuery(jobId);

  const fail = (err: unknown): void => setError(failureMessage(err, t));
  const status = exportStatus.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={busy && jobId === null}
          onClick={() => {
            setError(null);
            setBusy(true);
            requestExport()
              .then((job) => setJobId(job.job_id), fail)
              .finally(() => setBusy(false));
          }}
        >
          {t('privacy.export', 'Export my data')}
        </Button>
        <Button variant="secondary" onClick={() => setConfirmingAttention(true)}>
          {t('privacy.attentionDelete', 'Delete attention history')}
        </Button>
      </div>

      {status ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
          <span>
            {t(
              `privacy.export.${status.status}`,
              EXPORT_STATE_LABELS[status.status] ?? status.status,
            )}
          </span>
          {status.download_available && status.download_token ? (
            <>
              <Button
                variant="primary"
                onClick={() => {
                  setError(null);
                  gate
                    .guard(() => downloadExport(status.job_id, status.download_token as string))
                    .then((blob) => saveBlob(blob, 'licio-export.json'), fail);
                }}
              >
                {t('privacy.export.download', 'Download archive')}
              </Button>
              {status.expires_at ? (
                <span className="text-xs text-ink-muted">
                  {t('privacy.export.expires', 'Available until')}{' '}
                  {formatDate(Date.parse(status.expires_at), locale, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={confirmingAttention}
        onClose={() => setConfirmingAttention(false)}
        title={t('privacy.attentionDelete.title', 'Delete attention history?')}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">
            {t(
              'privacy.attentionDelete.desc',
              'This permanently removes your attention aggregates and derived topic affinities. It cannot be undone.',
            )}
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={() => {
                setError(null);
                setConfirmingAttention(false);
                deleteAttentionHistory('delete').then((result) => {
                  toast({
                    message: t('privacy.attentionDelete.done', 'Attention history deleted.'),
                  });
                  void result;
                }, fail);
              }}
            >
              {t('privacy.attentionDelete.confirm', 'Delete history')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingAttention(false)}>
              {t('privacy.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      </Dialog>

      {error ? (
        <p role="alert" className="text-sm text-error-on-soft">
          {error}
        </p>
      ) : null}
      <StepUpDialog {...gate.dialog} />
    </div>
  );
}

/** The account-deletion danger zone (request → 30-day grace → hard purge). */
export function DangerZoneSection(): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const gate = useStepUpGate();
  const logout = useAuthStore((s) => s.logout);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        {t(
          'privacy.deleteAccount.desc',
          'Deletion starts a 30-day grace period during which you can change your mind by signing back in. After that, your data is permanently removed. Public blockchain records (if any) cannot be erased.',
        )}
      </p>
      <div>
        <Button variant="destructive" onClick={() => setConfirming(true)}>
          {t('privacy.deleteAccount', 'Delete my account')}
        </Button>
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('privacy.deleteAccount.title', 'Delete your account?')}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">
            {t(
              'privacy.deleteAccount.confirmDesc',
              'You will be signed out everywhere immediately. You can cancel within 30 days by signing in again or using the link in the confirmation email; after that, deletion is permanent.',
            )}
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={() => {
                setError(null);
                setConfirming(false);
                gate
                  .guard(() => requestAccountDeletion())
                  .then(
                    () => {
                      toast({
                        message: t(
                          'privacy.deleteAccount.requested',
                          'Deletion requested. You have 30 days to change your mind.',
                        ),
                      });
                      // Every session is revoked server-side; clear local state too.
                      logout();
                    },
                    (err: unknown) => setError(failureMessage(err, t)),
                  );
              }}
            >
              {t('privacy.deleteAccount.confirm', 'Request deletion')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('privacy.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      </Dialog>

      {error ? (
        <p role="alert" className="text-sm text-error-on-soft">
          {error}
        </p>
      ) : null}
      <StepUpDialog {...gate.dialog} />
    </div>
  );
}
