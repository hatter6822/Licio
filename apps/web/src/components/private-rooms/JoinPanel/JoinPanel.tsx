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

import type { InviteSecret } from '@licio/private-p2p';
import { useId, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ApiClientError } from '../../../lib/api.js';
import { fetchPrivateRoomBootstrap } from '../../../lib/private-rooms-api.js';
import {
  manifestRoomPublicKey,
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
  /** The join request, KEYED to the invite it was built from — same reason as
   *  the directory verdict below: the crypto is async, so a slow `complete` can
   *  resolve after the field has moved on, and a request for the previous room
   *  beside a replacement link leads to completing the wrong join. */
  const [request, setRequest] = useState<{
    fragment: string;
    json: string;
    /** The room the invite this request was built from names. */
    roomPublicKey: string;
  } | null>(null);
  const [grantJson, setGrantJson] = useState('');
  const [joined, setJoined] = useState(false);
  /**
   * What Licio's record says about the room this invite claims to be for —
   * KEYED to the exact fragment it was computed from.
   *
   * A bare value went stale twice over: editing the field left the previous
   * room's reassuring verdict standing beside a new link, and a slow lookup for
   * the old invite could land after the field had already changed. Either way a
   * user reads evidence about one invite as evidence about another, which is
   * precisely the mistake this check exists to prevent.
   */
  const [recordCheck, setRecordCheck] = useState<{
    fragment: string;
    lookup: DirectoryLookup;
  } | null>(null);
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
    setRequest(null);
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
      const { invite, request: built } = await pending.complete(fragment);
      // The invite's ROOM travels with the request: a grant pasted later has to
      // answer THIS invite, and only the invite knows which room that is.
      setRequest({
        fragment,
        json: JSON.stringify(built),
        roomPublicKey: invite.room_public_key,
      });
      // Resolve Licio's record for the room, using the §21.2 capability the
      // invite carries — the reason it rides the SEALED invite rather than the
      // post-admission grant. See `lookUpDirectory` for what this does and does
      // not establish; either way it is a REPORT, never a gate.
      //
      // NOT AWAITED HERE, which is what makes that true. Awaiting it held `busy`
      // for as long as the request took, and a stalled directory read then
      // disabled the grant controls indefinitely — a check described as advisory
      // preventing a join it has no authority over. The join request is already
      // built and shown; the verdict lands beside it when it arrives, and it is
      // still keyed to this fragment so a late answer cannot describe a
      // different invite.
      void lookUpDirectory(invite).then(
        (lookup) => setRecordCheck({ fragment, lookup }),
        () => setRecordCheck({ fragment, lookup: { kind: 'unavailable' } }),
      );
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

  /** What the field holds right now — the key both async results must match. */
  const currentFragment = extractInviteFragment(sealedInvite.trim());
  /** The request, only while it still describes that fragment. */
  const requestJson =
    request !== null && request.fragment === currentFragment ? request.json : null;

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
      // THE GRANT MUST ANSWER THE INVITE ON SCREEN.
      //
      // One preparation reuses one KeyPackage across every invite it opens, so
      // a grant for room A verifies perfectly against a request built for room
      // B — and `completeJoin` would take it, joining A while the panel shows
      // B's invite. Clearing the field when the invite changes only helps when
      // the grant is already there; A's grant arriving afterwards is the case
      // that is left. The invite names its room, the grant's manifest names
      // its room, and they have to be the same room.
      const expected =
        request !== null && request.fragment === currentFragment
          ? request.roomPublicKey
          : undefined;
      if (expected !== undefined && manifestRoomPublicKey(grant.manifest) !== expected) {
        setError(
          t(
            'privateRoom.join.grantRoomMismatch',
            'That grant is for a different room than the invite on screen. Paste the grant that answers this invite.',
          ),
        );
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
            onChange={(e) => {
              setSealedInvite(e.target.value);
              // A new link invalidates BOTH results. The request blob is
              // derived from the old invite and the verdict describes the old
              // room; leaving either beside a changed link is how stale
              // evidence gets read as a check of what is on screen.
              setRequest(null);
              setRecordCheck(null);
              // The GRANT too. It answers the previous invite, and `completeJoin`
              // accepts whichever valid grant is pasted — the pending
              // preparation reuses one key package across both — so a stale
              // grant beside a replacement link joins room A while the screen
              // shows invite B.
              setGrantJson('');
              setError(null);
            }}
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

      {/* …and shown only while it still describes the link in the field, so a
          lookup that resolves after the input changed cannot surface. */}
      {recordCheck !== null && recordCheck.fragment === currentFragment ? (
        <p
          className={
            recordCheck.lookup.kind === 'unresolved'
              ? 'text-error-on-soft text-sm'
              : 'text-ink-muted text-sm'
          }
          role={recordCheck.lookup.kind === 'unresolved' ? 'alert' : 'status'}
        >
          {directoryMessage(t, recordCheck.lookup)}
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

  /**
   * A GRANT BELONGS TO THE REQUEST THAT PRODUCED IT — and so does every other
   * outcome of an admission.
   *
   * The grant was free-floating state that only ever got REPLACED, so after
   * admitting device A the panel kept showing A's grant under "send this back to
   * the new device" while the admin worked on device B. A rejected or failed B —
   * `verdict.ok === false`, a parse miss, a throw — writes no new grant, so the
   * label pointed at B and the value was A's: the admin sends an unusable grant
   * and B's join never completes, with nothing on screen saying so.
   *
   * Clearing on input change fixed the display but not the RACE behind it. The
   * admission is several async crypto steps and the fields stay editable
   * throughout, so A's in-flight attempt could resolve after the admin had typed
   * B's records — and its success branch writes A's grant AND blanks both fields,
   * destroying B's pasted input to show a grant for a different device.
   *
   * So an attempt is KEYED, the way the joiner half above keys its request and
   * its directory verdict to the invite fragment they came from: bumping
   * `attempt` supersedes whatever is in flight, and a superseded result is
   * dropped rather than rendered.
   */
  const attempt = useRef(0);

  function beginNewAdmission(): void {
    attempt.current += 1;
    setGrantJson(null);
    setStatus(null);
  }

  async function admit(): Promise<void> {
    if (!canAdmit) return;
    setBusy(true);
    setError(null);
    beginNewAdmission();
    const mine = attempt.current;
    /** Has the admin moved on since this attempt started? */
    const superseded = (): boolean => attempt.current !== mine;
    try {
      const invite = await PrivateRoomSession.parseInvite(inviteJson.trim());
      if (superseded()) return;
      if (invite === null) {
        setError(t('privateRoom.admit.badInvite', 'That invite record is not valid.'));
        return;
      }
      const request = await PrivateRoomSession.parseJoinRequest(requestJson.trim());
      if (superseded()) return;
      if (request === null) {
        setError(t('privateRoom.admit.badRequest', 'That join request is not valid.'));
        return;
      }
      const { verdict, grant } = await session.admitJoinRequest(invite, request);
      // The DEVICE IS ADMITTED either way — this is a display decision, not a
      // crypto one, and dropping the render is the honest half: the admin is
      // looking at another device's records, and `member.add` has committed to
      // the room state they can see in the member list.
      if (superseded()) return;
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
      if (superseded()) return;
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
        onChange={(e) => {
          setInviteJson(e.target.value);
          beginNewAdmission();
        }}
        rows={2}
      />
      <TextArea
        label={t('privateRoom.admit.requestLabel', 'Join request')}
        value={requestJson}
        onChange={(e) => {
          setRequestJson(e.target.value);
          beginNewAdmission();
        }}
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

/**
 * The one sentence a lookup outcome is worth, chosen by CASE rather than by a
 * chain of ternaries — four outcomes is where that chain stops being readable,
 * and only one of them may sound like a warning.
 */
function directoryMessage(t: ReturnType<typeof useT>, lookup: DirectoryLookup): string {
  switch (lookup.kind) {
    case 'unresolved':
      return t(
        'privateRoom.join.recordUnresolved',
        'Warning: this invite points at a Licio directory record that does not resolve. Check with whoever sent it before joining.',
      );
    case 'unavailable':
      return t(
        'privateRoom.join.recordUnavailable',
        'Licio’s record for this room could not be checked right now — that is about the connection, not the invite. You can still continue.',
      );
    case 'none':
      return t(
        'privateRoom.join.recordNone',
        'Licio holds no record of this room — expected if it was created without one. Nothing else about the invite is affected.',
      );
    case 'resolved':
      // NOT "this room's record" — nothing here can establish that yet.
      //
      // The invite names a record and carries the token that opens it, and both
      // fields are chosen by whoever built the invite. An inviter who belongs to
      // room A and administers room B can put A's handle into B's invite, and
      // the two keys available before joining are not comparable: the record
      // carries the founder DEVICE signing key, the invite carries the room's
      // MANIFEST key. The tie is the manifest commitment, which arrives with the
      // grant — so the honest report is what resolved, and that the panel checks
      // it against the room once joined (`verifyDirectoryRecord`).
      return lookup.name !== null
        ? t(
            'privateRoom.join.recordListed',
            'The invite names a Licio record, and it resolves — published as “{name}”. That name is not yet evidence about the room you are joining: it is checked against the room itself once you are in.',
            { name: lookup.name },
          )
        : t(
            'privateRoom.join.recordUnlisted',
            'The invite names a Licio record, and it resolves. It publishes no name, and it is checked against the room itself once you are in.',
          );
  }
}

/** What Licio's directory says about the room an invite is for. */
type DirectoryLookup =
  | { kind: 'resolved'; name: string | null }
  | { kind: 'unresolved' }
  | { kind: 'unavailable' }
  | { kind: 'none' };

/**
 * Resolve the invite's §21 directory record with the capability it carries.
 *
 * What a RESOLVE establishes: the record exists and the token in this invite is
 * the one that opens it — a token derived from the room's epoch-0 rendezvous
 * key, so whoever built the invite had, or was given, something only the room
 * holds. It also shows the invitee the public name before they commit, which is
 * the point of `listed`.
 *
 * What it does NOT establish, and the copy must not imply: that the record and
 * the invite describe the same room by cryptographic identity. They carry
 * DIFFERENT keys — the stub's `room_public_key` is the founder device's Ed25519
 * signing key, the invite's is the manifest's HPKE invite key — so comparing
 * them would fail on every honest invite, which is exactly the kind of check
 * that trains people to click through warnings.
 *
 * A room with no record at all is ordinary — `detached`, or a registration that
 * did not succeed — and reads as "none".
 *
 * Only a 404 is evidence AGAINST the invite, and it is decisive: §21.2 makes an
 * unknown room, a wrong token and a malformed id one answer, so a 404 here means
 * "no record you can reach with this capability" and nothing else. Every other
 * failure — offline, a 5xx, a proxy — is evidence about the network, and
 * reporting it as "this invite points at a record that does not exist" would put
 * a security warning in front of someone whose only mistake was a bad
 * connection. That is how people learn to click through warnings.
 */
async function lookUpDirectory(invite: InviteSecret): Promise<DirectoryLookup> {
  const roomServerId = invite.room_stub_ref;
  const token = invite.bootstrap_blind_id;
  if (roomServerId === undefined || token === undefined) return { kind: 'none' };
  try {
    const record = await fetchPrivateRoomBootstrap(roomServerId, token);
    return { kind: 'resolved', name: record.display_name };
  } catch (error) {
    const status = error instanceof ApiClientError ? error.status : undefined;
    return status === 404 ? { kind: 'unresolved' } : { kind: 'unavailable' };
  }
}

/** Accept either a full invite URL (`…#invite=<sealed>`) or a bare sealed string,
 *  returning the sealed-invite payload `prepareJoinRequest().complete` expects. */
function extractInviteFragment(input: string): string {
  const marker = '#invite=';
  const at = input.indexOf(marker);
  return at >= 0 ? input.slice(at + marker.length) : input;
}
