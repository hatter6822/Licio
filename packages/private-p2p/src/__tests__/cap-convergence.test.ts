// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — issuer-key CONVERGENCE (PRIV-CAP-3) + adversarial install cases (PRIV-CAP-5).
// A multi-admin / seed-regenerated room can have `rendezvous.issue` ops under DIFFERENT issuer keys;
// every device must converge on ONE canonical key (the earliest-reduced issuance's), or a legit
// peer's cap would fail to verify at a peer that installed a different admin's key — silently denying
// capped discovery instead of riding Tier-1.  Real BBS crypto, no transport.
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../crypto/runtime.js';
import {
  buildIssuanceOpBody,
  canonicalIssuerKey,
  type DeviceCommitment,
  installFromIssuances,
} from '../rendezvous-cap/coordinator.js';
import { RendezvousIssuer, RendezvousMember } from '../rendezvous-cap/session.js';

function enrolledKeyB64(member: RendezvousMember, epoch: string): string | null {
  const key = member.issuerKey(epoch);
  return key === null ? null : toBase64Url(key);
}

describe('rendezvous-cap issuer convergence (PRIV-CAP-3)', () => {
  it('converges on the canonical (earliest-reduced) issuer key in a multi-admin room', () => {
    const member = new RendezvousMember();
    const commitment: DeviceCommitment = {
      deviceId: 'dev-1',
      commitmentWithProof: toBase64Url(member.commitment),
    };
    const issuerA = RendezvousIssuer.generate('0');
    const issuerB = RendezvousIssuer.generate('0');
    const issuanceA = buildIssuanceOpBody(issuerA, 0, [commitment]);
    const issuanceB = buildIssuanceOpBody(issuerB, 0, [commitment]);
    if (!issuanceA || !issuanceB) throw new Error('issuance build failed');
    expect(issuanceA.issuer_public_key).not.toBe(issuanceB.issuer_public_key); // two distinct admins

    // The op log reduces A before B ⇒ A is canonical, and the device enrolls under A.
    expect(canonicalIssuerKey(0, [issuanceA, issuanceB])).toBe(issuanceA.issuer_public_key);
    expect(installFromIssuances(member, 'dev-1', 0, [issuanceA, issuanceB])).toBe(true);
    expect(enrolledKeyB64(member, '0')).toBe(issuanceA.issuer_public_key);
  });

  it('re-installs under the canonical key when previously enrolled under a non-canonical one', () => {
    const member = new RendezvousMember();
    const commitment: DeviceCommitment = {
      deviceId: 'dev-1',
      commitmentWithProof: toBase64Url(member.commitment),
    };
    const issuerA = RendezvousIssuer.generate('0');
    const issuerB = RendezvousIssuer.generate('0');
    const issuanceA = buildIssuanceOpBody(issuerA, 0, [commitment]);
    const issuanceB = buildIssuanceOpBody(issuerB, 0, [commitment]);
    if (!issuanceA || !issuanceB) throw new Error('issuance build failed');

    // Only B is visible first ⇒ the device enrolls under B (canonical for [B]).
    installFromIssuances(member, 'dev-1', 0, [issuanceB]);
    expect(enrolledKeyB64(member, '0')).toBe(issuanceB.issuer_public_key);
    // Now A appears EARLIER in the reduced log ⇒ canonical = A ⇒ the stale B enrollment is replaced.
    installFromIssuances(member, 'dev-1', 0, [issuanceA, issuanceB]);
    expect(enrolledKeyB64(member, '0')).toBe(issuanceA.issuer_public_key);
  });

  it('rides Tier-1 (drops any stale enrollment) when no canonical-key credential exists (PRIV-CAP-5)', () => {
    const member = new RendezvousMember();
    const other = new RendezvousMember();
    const issuerA = RendezvousIssuer.generate('0');
    // The canonical key exists, but A issued only for ANOTHER device — never our device.
    const issuanceA = buildIssuanceOpBody(issuerA, 0, [
      { deviceId: 'other', commitmentWithProof: toBase64Url(other.commitment) },
    ]);
    if (!issuanceA) throw new Error('issuance build failed');
    expect(installFromIssuances(member, 'dev-1', 0, [issuanceA])).toBe(false);
    expect(member.isEnrolled('0')).toBe(false); // rides Tier-1; never announces under a wrong key
  });

  it('drops a stale enrollment when the epoch loses its issuance entirely (PRIV-CAP-5)', () => {
    const member = new RendezvousMember();
    const commitment: DeviceCommitment = {
      deviceId: 'dev-1',
      commitmentWithProof: toBase64Url(member.commitment),
    };
    const issuer = RendezvousIssuer.generate('0');
    const issuance = buildIssuanceOpBody(issuer, 0, [commitment]);
    if (!issuance) throw new Error('issuance build failed');
    expect(installFromIssuances(member, 'dev-1', 0, [issuance])).toBe(true);
    expect(member.isEnrolled('0')).toBe(true);
    // No issuance for the epoch anymore (a different reduced view) ⇒ forget + ride Tier-1.
    expect(installFromIssuances(member, 'dev-1', 0, [])).toBe(false);
    expect(member.isEnrolled('0')).toBe(false);
  });
});
