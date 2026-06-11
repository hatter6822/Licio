// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wallet-drainer link interstitial (WS-G.4.2c, SPEC §18.5).  Shows the FULL
// URL for inspection before navigating to a destination the blocklist or the
// contract-interaction heuristics flagged.  Continue/back only — never a
// silent block, and the choice is not logged against the user's identity.
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button/index.js';
import { Dialog } from '../ui/Dialog/index.js';

export interface LinkInterstitialProps {
  url: string;
  onContinue: () => void;
  onBack: () => void;
}

export function LinkInterstitial({
  url,
  onContinue,
  onBack,
}: LinkInterstitialProps): React.ReactElement {
  const t = useT();
  return (
    <Dialog
      open
      onClose={onBack}
      title={t('linkSafety.title', 'Check this link before continuing')}
      describedById="link-interstitial-description"
    >
      <div className="flex flex-col gap-4">
        <p id="link-interstitial-description" className="text-sm text-ink">
          {t(
            'linkSafety.warning',
            'This link may interact with your wallet. Verify the URL and contract before proceeding.',
          )}
        </p>
        <p className="break-all rounded-md border border-line bg-surface-sunken p-3 font-mono text-xs text-ink">
          {url}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onBack}>
            {t('linkSafety.back', 'Go back')}
          </Button>
          <Button variant="primary" onClick={onContinue}>
            {t('linkSafety.continue', 'Continue to site')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
