// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the §10.3 invite panel.  An admin mints an invite and HPKE-seals it
// to the invitee's recipient public key (which the invitee produced in the Join
// panel and shared out-of-band), then this renders the resulting invite as a URL
// whose SECRET lives only in the FRAGMENT (`…#invite=`) — so an ordinary request
// never transmits it to a server.  The crypto runs through
// `PrivateRoomSession.createInvite` (the code-split core), never imported here.
// The honest §20.2-style disclosure spells out that the invite is delivered by
// the user over a channel they trust; Licio routes nothing.

import { useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { copyText } from '../../../lib/clipboard.js';
import type { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';
import { Input } from '../../ui/Input/index.js';
import { TextArea } from '../../ui/TextArea/index.js';

export interface InvitePanelProps {
  session: PrivateRoomSession;
}

export function InvitePanel({ session }: InvitePanelProps): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [inviteePublicKey, setInviteePublicKey] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteJson, setInviteJson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canMint = inviteePublicKey.trim().length > 0 && !busy;

  async function mint(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canMint) return;
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    setInviteJson(null);
    setCopied(false);
    try {
      const { invite, inviteUrl: url } = await session.createInvite({
        inviteePublicKey: inviteePublicKey.trim(),
      });
      setInviteUrl(url);
      setInviteJson(JSON.stringify(invite));
    } catch {
      setError(
        t(
          'privateRoom.invite.error',
          'Could not create the invite. Check the invitee key and try again.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (inviteUrl === null) return;
    // An invite link that reports "Copied" without copying is worse than one
    // that reports nothing: the admin pastes whatever was on the clipboard
    // before into the channel they chose to deliver it over. The link stays
    // selectable in the field regardless.
    if (await copyText(inviteUrl)) setCopied(true);
  }

  return (
    <Card>
      <form aria-labelledby={headingId} onSubmit={mint} className="flex flex-col gap-3" noValidate>
        <h3 id={headingId} className="font-semibold text-sm">
          {t('privateRoom.invite.title', 'Invite a device')}
        </h3>
        <p className="neu-inset rounded-lg p-3 text-ink-muted text-sm" role="note">
          {t(
            'privateRoom.invite.note',
            'The invite is sealed to the invitee’s key and carried only in the link’s fragment, so Licio never sees it. You deliver the link yourself over a channel you trust. Anyone who opens it can join until it expires or is used up.',
          )}
        </p>

        <Input
          label={t('privateRoom.invite.inviteeKey', 'Invitee recipient key (from their Join tab)')}
          value={inviteePublicKey}
          onChange={(e) => setInviteePublicKey(e.target.value)}
          required
        />

        <Button type="submit" variant="primary" disabled={!canMint}>
          {busy
            ? t('privateRoom.invite.minting', 'Sealing invite…')
            : t('privateRoom.invite.mint', 'Create invite link')}
        </Button>

        {error ? (
          <p className="text-error-on-soft text-sm" role="alert">
            {error}
          </p>
        ) : null}

        {inviteUrl !== null ? (
          <div className="flex flex-col gap-2">
            <TextArea
              label={t('privateRoom.invite.urlLabel', 'Invite link (deliver it yourself)')}
              value={inviteUrl}
              readOnly
              rows={3}
            />
            <Button type="button" variant="secondary" onClick={copy}>
              {copied
                ? t('privateRoom.invite.copied', 'Copied')
                : t('privateRoom.invite.copy', 'Copy invite link')}
            </Button>
            {inviteJson !== null ? (
              <TextArea
                label={t(
                  'privateRoom.invite.recordLabel',
                  'Keep this invite record (paste it into Admit to approve the join)',
                )}
                value={inviteJson}
                readOnly
                rows={2}
              />
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}
