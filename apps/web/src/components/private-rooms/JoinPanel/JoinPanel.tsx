// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the §12.3 join + admit panel.  Two roles, both pure-client over the
// code-split crypto core (reached only through `PrivateRoomSession`):
//
//  • JOINER (no room yet): generate this device's keys, share the recipient key
//    with an admin, then paste the sealed invite link to produce the §12.3
//    join-request blob to hand back.  (`PrivateRoomSession.prepareJoinRequest`.)
//  • ADMIT (an admin in the room): paste the invite record + the join request;
//    the request is verified against the invite and the device is admitted (the
//    MLS Add + signed `member.add`, carrying the proposed display name).  Every
//    rejection (expired / used up / wrong invite / bad proof / bad key package)
//    is surfaced honestly.
//
// The JOINER half stands alone (no `session` — the joiner is not yet a member);
// the ADMIT half drives an existing `session`.

import { useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import {
  PrivateRoomSession,
  parseJoinGrant,
  serializeJoinGrant,
} from '../../../private-p2p/room-manager.js';
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';
import { Input } from '../../ui/Input/index.js';
import { TextArea } from '../../ui/TextArea/index.js';

export interface JoinPanelProps {
  /** When present, the ADMIT half is shown for this in-room admin session. */
  session?: PrivateRoomSession | undefined;
  /** Called once the JOINER finishes `completeJoin` with the new room's id (so the
   *  caller can navigate into it). */
  onJoined?: (roomId: string) => void;
}

/** Map a §12.3 verify rejection to honest, user-facing copy (never silent). */
function rejectionMessage(
  t: ReturnType<typeof useT>,
  reason:
    | 'expired'
    | 'exhausted'
    | 'invite_id_mismatch'
    | 'proof_invalid'
    | 'malformed_key_package',
): string {
  switch (reason) {
    case 'expired':
      return t('privateRoom.admit.reasonExpired', 'This invite has expired.');
    case 'exhausted':
      return t('privateRoom.admit.reasonExhausted', 'This invite has already been used up.');
    case 'invite_id_mismatch':
      return t('privateRoom.admit.reasonMismatch', 'The join request does not match this invite.');
    case 'proof_invalid':
      return t(
        'privateRoom.admit.reasonProof',
        'The join request could not prove it holds this invite.',
      );
    case 'malformed_key_package':
      return t('privateRoom.admit.reasonKeyPackage', 'The device key package is invalid.');
  }
}

export function JoinPanel({ session, onJoined }: JoinPanelProps): React.ReactElement {
  return (
    <Card>
      <div className="flex flex-col gap-6">
        <JoinerSection onJoined={onJoined} />
        {session ? <AdmitSection session={session} /> : null}
      </div>
    </Card>
  );
}

/** The JOINER half — produce a recipient key + a join-request blob, then finish the
 *  join from the admin's grant. */
function JoinerSection({
  onJoined,
}: {
  onJoined: ((roomId: string) => void) | undefined;
}): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [displayName, setDisplayName] = useState('');
  const [recipientKey, setRecipientKey] = useState<string | null>(null);
  const [sealedInvite, setSealedInvite] = useState('');
  const [requestJson, setRequestJson] = useState<string | null>(null);
  const [grantJson, setGrantJson] = useState('');
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The pending preparation: holds the joiner's keys + the `complete`/`completeJoin` steps.
  const [pending, setPending] = useState<Awaited<
    ReturnType<typeof PrivateRoomSession.prepareJoinRequest>
  > | null>(null);

  async function startPrepare(): Promise<void> {
    if (displayName.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setRequestJson(null);
    try {
      const prep = await PrivateRoomSession.prepareJoinRequest({
        proposedDisplayName: displayName.trim(),
      });
      setPending(prep);
      setRecipientKey(prep.inviteePublicKey);
    } catch {
      setError(t('privateRoom.join.prepError', 'Could not prepare a join request.'));
    } finally {
      setBusy(false);
    }
  }

  async function buildRequest(): Promise<void> {
    if (!pending || sealedInvite.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fragment = extractInviteFragment(sealedInvite.trim());
      const { request } = await pending.complete(fragment);
      setRequestJson(JSON.stringify(request));
    } catch {
      setError(
        t(
          'privateRoom.join.openError',
          'That invite link could not be opened. It may be malformed or not for this device.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function finishJoin(): Promise<void> {
    if (!pending || grantJson.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const grant = parseJoinGrant(grantJson.trim());
      if (grant === null) {
        setError(t('privateRoom.join.badGrant', 'That join grant is not valid.'));
        return;
      }
      const room = await pending.completeJoin(grant);
      setJoined(true);
      onJoined?.(room.roomId);
    } catch {
      setError(t('privateRoom.join.finishError', 'Could not finish joining the room.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="font-semibold text-sm">
        {t('privateRoom.join.title', 'Join a room')}
      </h3>
      <p className="neu-inset rounded-lg p-3 text-ink-muted text-sm" role="note">
        {t(
          'privateRoom.join.note',
          'Share your recipient key with an admin so they can seal an invite to you, then paste the invite link they send back. Everything stays on your device until you are admitted.',
        )}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <Input
          label={t('privateRoom.join.displayName', 'Your display name')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="flex-1"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={startPrepare}
          disabled={busy || displayName.trim().length === 0}
        >
          {t('privateRoom.join.prepare', 'Get my recipient key')}
        </Button>
      </div>

      {recipientKey !== null ? (
        <TextArea
          label={t('privateRoom.join.recipientKey', 'Your recipient key (send to an admin)')}
          value={recipientKey}
          readOnly
          rows={2}
        />
      ) : null}

      {pending ? (
        <div className="flex flex-col gap-2">
          <TextArea
            label={t('privateRoom.join.sealedInvite', 'Paste the invite link from the admin')}
            value={sealedInvite}
            onChange={(e) => setSealedInvite(e.target.value)}
            rows={2}
          />
          <Button
            type="button"
            variant="primary"
            onClick={buildRequest}
            disabled={busy || sealedInvite.trim().length === 0}
          >
            {t('privateRoom.join.build', 'Build join request')}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="text-error-on-soft text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {requestJson !== null ? (
        <TextArea
          label={t('privateRoom.join.requestLabel', 'Your join request (send to the admin)')}
          value={requestJson}
          readOnly
          rows={3}
        />
      ) : null}

      {requestJson !== null && !joined ? (
        <div className="flex flex-col gap-2">
          <TextArea
            label={t('privateRoom.join.grantLabel', 'Paste the grant the admin sent back')}
            value={grantJson}
            onChange={(e) => setGrantJson(e.target.value)}
            rows={3}
          />
          <Button
            type="button"
            variant="primary"
            onClick={finishJoin}
            disabled={busy || grantJson.trim().length === 0}
          >
            {t('privateRoom.join.finish', 'Finish joining')}
          </Button>
        </div>
      ) : null}

      {joined ? (
        <p className="text-success-on-soft text-sm" role="status">
          {t('privateRoom.join.joined', 'You have joined the room. It is now on your device.')}
        </p>
      ) : null}
    </section>
  );
}

/** The ADMIT half — verify a join request against an invite + admit the device. */
function AdmitSection({ session }: { session: PrivateRoomSession }): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [inviteJson, setInviteJson] = useState('');
  const [requestJson, setRequestJson] = useState('');
  const [grantJson, setGrantJson] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canAdmit = inviteJson.trim().length > 0 && requestJson.trim().length > 0 && !busy;

  async function admit(): Promise<void> {
    if (!canAdmit) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const invite = await PrivateRoomSession.parseInvite(inviteJson.trim());
      if (invite === null) {
        setError(t('privateRoom.admit.badInvite', 'That invite record is not valid.'));
        return;
      }
      const request = await PrivateRoomSession.parseJoinRequest(requestJson.trim());
      if (request === null) {
        setError(t('privateRoom.admit.badRequest', 'That join request is not valid.'));
        return;
      }
      const { verdict, grant } = await session.admitJoinRequest(invite, request);
      if (verdict.ok) {
        setStatus(
          t('privateRoom.admit.ok', 'Device admitted as {role}.', { role: verdict.grantedRole }),
        );
        // The grant carries the MLS Welcome + the new device's current-state bootstrap;
        // the admin sends it back to the joining device to finish the join.
        if (grant) setGrantJson(serializeJoinGrant(grant));
        setInviteJson('');
        setRequestJson('');
      } else {
        setError(rejectionMessage(t, verdict.reason));
      }
    } catch {
      setError(t('privateRoom.admit.error', 'Could not admit the device.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 border-line border-t pt-4">
      <h3 id={headingId} className="font-semibold text-sm">
        {t('privateRoom.admit.title', 'Admit a device')}
      </h3>
      <p className="text-ink-muted text-sm">
        {t(
          'privateRoom.admit.note',
          'Paste the invite record you kept and the join request the new device sent you. The request is checked against the invite before the device is added.',
        )}
      </p>

      <TextArea
        label={t('privateRoom.admit.inviteLabel', 'Invite record')}
        value={inviteJson}
        onChange={(e) => setInviteJson(e.target.value)}
        rows={2}
      />
      <TextArea
        label={t('privateRoom.admit.requestLabel', 'Join request')}
        value={requestJson}
        onChange={(e) => setRequestJson(e.target.value)}
        rows={3}
      />

      <Button type="button" variant="primary" onClick={admit} disabled={!canAdmit}>
        {busy
          ? t('privateRoom.admit.admitting', 'Admitting…')
          : t('privateRoom.admit.admit', 'Verify and admit')}
      </Button>

      {error ? (
        <p className="text-error-on-soft text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {status !== null ? (
        <p className="text-success-on-soft text-sm" role="status">
          {status}
        </p>
      ) : null}
      {grantJson !== null ? (
        <TextArea
          label={t(
            'privateRoom.admit.grantLabel',
            'Send this back to the new device to finish joining',
          )}
          value={grantJson}
          readOnly
          rows={3}
        />
      ) : null}
    </section>
  );
}

/** Accept either a full invite URL (`…#invite=<sealed>`) or a bare sealed string,
 *  returning the sealed-invite payload `prepareJoinRequest().complete` expects. */
function extractInviteFragment(input: string): string {
  const marker = '#invite=';
  const at = input.indexOf(marker);
  return at >= 0 ? input.slice(at + marker.length) : input;
}
