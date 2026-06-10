// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Step-up dialog (WS-D.1.3e): satisfies a fresh-authentication challenge with a
// passkey assertion or an emailed one-time code, then hands control back to the
// gate so the interrupted action retries.  Renders inside the accessible Dialog
// primitive (focus trap, esc/backdrop dismissal).
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { stepUpEmailStart, stepUpEmailVerify, stepUpWithPasskey } from '../../../lib/auth-api.js';
import { isWebAuthnAvailable } from '../../../lib/webauthn.js';
import { Button } from '../../ui/Button/index.js';
import { Dialog } from '../../ui/Dialog/index.js';
import { Input } from '../../ui/Input/index.js';

export interface StepUpDialogProps {
  open: boolean;
  onClose: () => void;
  onSatisfied: () => void;
}

export function StepUpDialog({
  open,
  onClose,
  onSatisfied,
}: StepUpDialogProps): React.ReactElement {
  const t = useT();
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passkeysAvailable = isWebAuthnAvailable();

  const run = async (flow: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await flow();
    } catch {
      setError(t('stepup.error', 'That did not work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const finish = (): void => {
    setCode('');
    setCodeSent(false);
    setError(null);
    onSatisfied();
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('stepup.title', 'Confirm it is you')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">
          {t(
            'stepup.description',
            'This is a sensitive change, so please confirm your identity again.',
          )}
        </p>

        {passkeysAvailable ? (
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              void run(async () => {
                await stepUpWithPasskey();
                finish();
              })
            }
          >
            {t('stepup.passkey', 'Confirm with a passkey')}
          </Button>
        ) : null}

        {codeSent ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await stepUpEmailVerify(code);
                finish();
              });
            }}
          >
            <Input
              label={t('stepup.code', 'Confirmation code')}
              helperText={t('stepup.codeHelp', 'Enter the 8-character code we emailed you.')}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <Button type="submit" variant="primary" loading={busy}>
              {t('stepup.codeSubmit', 'Confirm')}
            </Button>
          </form>
        ) : (
          <Button
            variant={passkeysAvailable ? 'secondary' : 'primary'}
            loading={busy}
            onClick={() =>
              void run(async () => {
                await stepUpEmailStart();
                setCodeSent(true);
              })
            }
          >
            {t('stepup.email', 'Email me a confirmation code')}
          </Button>
        )}

        {error ? (
          <p role="alert" className="text-sm text-error-on-soft">
            {error}
          </p>
        ) : null}

        <Button variant="ghost" onClick={onClose}>
          {t('stepup.cancel', 'Cancel')}
        </Button>
      </div>
    </Dialog>
  );
}
