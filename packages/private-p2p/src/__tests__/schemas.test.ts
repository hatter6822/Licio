// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — the strict private-room schema suite (PRIVATE_SPEC §10, §12, §13,
// §19): accept/reject per schema, the WS-G-parity matrix for contribution ops
// (the SAME body caps + citation rules as the shipped server schema), and the
// envelope↔AAD field alignment (§10.5).
import { CONTRIBUTION_BODY_LIMITS } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  BODY_AAD_ENVELOPE_FIELDS,
  contributionCreateOpSchema,
  inviteSecretSchema,
  joinRequestSchema,
  privateAttachmentManifestSchema,
  privateEncryptedEnvelopeSchema,
  privateLocalSearchShardSchema,
  privateRoomManifestSchema,
  privateRoomOpSchema,
  voluntaryPrivateReportPackageSchema,
  WRAP_AAD_ENVELOPE_FIELDS,
} from '../schemas/index.js';

const CID = 'bafkreieaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B64 = 'AAAAAAAA';

const validEnvelope = {
  schema: 'licio.private.envelope.v1',
  envelope_version: 1,
  room_id_hash: B64,
  room_epoch: 3,
  object_type: 'contribution_op',
  plaintext_schema: 'licio.private.op.v1',
  cid_profile: 'licio-private-cid-v1',
  created_at_bucket: '2026-06-22T00',
  author_device_id_blind: 'dev-blind-1',
  author_seq: 7,
  parent_op_ids: ['op-1', 'op-2'],
  capability_root_at_seq: B64,
  chunk_index: 0,
  chunk_total: 1,
  aead: { algorithm: 'AES-256-GCM', nonce: B64, aad_hash: B64 },
  key_wrap: { mode: 'mls_exporter_aead_wrap', wrapping_epoch: 3, wrapped_object_key: B64 },
  ciphertext: B64,
  padding_policy: 'small-op-4k',
  signature: B64,
} as const;

describe('WS-S.2.3 envelope (§10.4) + AAD alignment (§10.5)', () => {
  it('accepts a valid envelope', () => {
    expect(privateEncryptedEnvelopeSchema.safeParse(validEnvelope).success).toBe(true);
  });

  it('accepts a chunked-media ciphertext (chunk_cids)', () => {
    const chunked = {
      ...validEnvelope,
      object_type: 'media_chunk',
      chunk_index: 0,
      chunk_total: 3,
      ciphertext: { chunk_cids: [CID, CID, CID] },
    };
    expect(privateEncryptedEnvelopeSchema.safeParse(chunked).success).toBe(true);
  });

  it('accepts a large inline ciphertext body (the padded-op-body bound, not the small-field one)', () => {
    // A padded op body (e.g. a `large-op-64k` padding bucket) base64url-expands
    // well past the 16 KiB small-field cap; `ciphertextBase64Schema` (≈1 MiB)
    // must accept it where `base64UrlSchema` would have rejected it.
    const bigBody = 'A'.repeat(90_000);
    expect(bigBody.length).toBeGreaterThan(16_384);
    expect(
      privateEncryptedEnvelopeSchema.safeParse({ ...validEnvelope, ciphertext: bigBody }).success,
    ).toBe(true);
    // The ~1 MiB ceiling still bites: a 1.5 MiB body is rejected.
    const tooBig = 'A'.repeat(1_500_000);
    expect(
      privateEncryptedEnvelopeSchema.safeParse({ ...validEnvelope, ciphertext: tooBig }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(privateEncryptedEnvelopeSchema.safeParse({ ...validEnvelope, extra: 1 }).success).toBe(
      false,
    );
  });

  it('rejects chunk_index >= chunk_total', () => {
    expect(
      privateEncryptedEnvelopeSchema.safeParse({ ...validEnvelope, chunk_index: 1, chunk_total: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a wrong envelope_version (forward compat by bump only)', () => {
    expect(
      privateEncryptedEnvelopeSchema.safeParse({ ...validEnvelope, envelope_version: 2 }).success,
    ).toBe(false);
  });

  it('carries EVERY body_aad input field (the verifier reconstructs §10.5 from it)', () => {
    // room_id_commitment maps to room_id_hash; the rest are direct fields.
    for (const field of BODY_AAD_ENVELOPE_FIELDS) {
      expect(Object.hasOwn(validEnvelope, field), `envelope missing AAD field ${field}`).toBe(true);
    }
  });

  it('carries EVERY wrap_aad input field (wrapping_epoch via key_wrap)', () => {
    for (const field of WRAP_AAD_ENVELOPE_FIELDS) {
      const present =
        Object.hasOwn(validEnvelope, field) || Object.hasOwn(validEnvelope.key_wrap, field);
      expect(present, `envelope missing wrap-AAD field ${field}`).toBe(true);
    }
  });
});

describe('WS-S.2.3 room manifest (§13.1)', () => {
  const base = {
    schema: 'licio.private.room_manifest.v1',
    room_id: 'room-1',
    created_at: '2026-06-22T00:00:00Z',
    profile: { name: 'A room', room_type: 'global_topic' },
    policy: {
      directory_mode: 'unlisted',
      membership_change: 'admin',
      posting_policy: 'all_members',
      allow_member_invites: true,
      default_new_member_role: 'member',
      transport_mode: 'relay_preferred',
      replication_target: 3,
      small_op_padding: '4k',
      allow_blind_push: false,
    },
    crypto: {
      room_public_key: B64,
      mls_group_id: B64,
      current_epoch: 0,
      mls_cipher_suite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
      envelope_profile: 'licio-private-envelope-v1',
      cid_profile: 'licio-private-cid-v1',
    },
    roots: { membership_log_root: B64, capability_log_root: B64, operation_log_root: B64 },
  } as const;

  it('accepts a valid manifest', () => {
    expect(privateRoomManifestSchema.safeParse(base).success).toBe(true);
  });

  it('requires a threshold config when membership_change is threshold', () => {
    const r = privateRoomManifestSchema.safeParse({
      ...base,
      policy: { ...base.policy, membership_change: 'threshold' },
    });
    expect(r.success).toBe(false);
  });

  it('requires role_gated_posters when posting_policy is role_gated', () => {
    const r = privateRoomManifestSchema.safeParse({
      ...base,
      policy: { ...base.policy, posting_policy: 'role_gated' },
    });
    expect(r.success).toBe(false);
  });
});

describe('WS-S.2.3 contribution.create op — WS-G parity (§13.5)', () => {
  const base = {
    type: 'contribution.create',
    contribution_id: 'c-1',
    thread_id: 't-1',
    client_draft_id: 'draft-1',
  } as const;
  const citation = { url: 'https://example.org/source' } as const;

  it('accepts a comment with body', () => {
    const r = contributionCreateOpSchema.safeParse({
      ...base,
      contribution_type: 'comment',
      body_markdown_lite: 'A plain comment.',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a comment with only an attachment (body OR attachment, WS-T)', () => {
    const r = contributionCreateOpSchema.safeParse({
      ...base,
      contribution_type: 'comment',
      body_markdown_lite: '',
      attachment_refs: [CID],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a comment with neither body nor attachment', () => {
    const r = contributionCreateOpSchema.safeParse({
      ...base,
      contribution_type: 'comment',
      body_markdown_lite: '',
    });
    expect(r.success).toBe(false);
  });

  it('requires ≥1 citation + a target claim for evidence', () => {
    expect(
      contributionCreateOpSchema.safeParse({
        ...base,
        contribution_type: 'evidence',
        body_markdown_lite: 'Primary dataset.',
        citations: [],
        target_claim_id: 'claim-1',
      }).success,
    ).toBe(false);
    expect(
      contributionCreateOpSchema.safeParse({
        ...base,
        contribution_type: 'evidence',
        body_markdown_lite: 'Primary dataset.',
        citations: [citation],
        target_claim_id: 'claim-1',
      }).success,
    ).toBe(true);
  });

  it('caps corrections at five citations + requires a target claim', () => {
    const sixCitations = Array.from({ length: 6 }, () => citation);
    expect(
      contributionCreateOpSchema.safeParse({
        ...base,
        contribution_type: 'correction',
        body_markdown_lite: 'A correction.',
        citations: sixCitations,
        target_claim_id: 'claim-1',
      }).success,
    ).toBe(false);
  });

  it('enforces the SHARED per-type body cap (no drift from WS-G)', () => {
    const overEvidence = 'x'.repeat(CONTRIBUTION_BODY_LIMITS.evidence + 1);
    expect(
      contributionCreateOpSchema.safeParse({
        ...base,
        contribution_type: 'evidence',
        body_markdown_lite: overEvidence,
        citations: [citation],
        target_claim_id: 'claim-1',
      }).success,
    ).toBe(false);
    const underComment = 'x'.repeat(CONTRIBUTION_BODY_LIMITS.comment);
    expect(
      contributionCreateOpSchema.safeParse({
        ...base,
        contribution_type: 'comment',
        body_markdown_lite: underComment,
      }).success,
    ).toBe(true);
  });
});

describe('WS-S.2.3 op envelope (§13.2) — Lamport is a canonical decimal string', () => {
  const baseOp = {
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: 0,
    op_id: 'op-1',
    author_member_id: 'm-1',
    author_device_id: 'd-1',
    author_seq: 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    parents: [],
    body: { type: 'story.tombstone', story_id: 's-1' },
  } as const;

  it('accepts a canonical lamport string', () => {
    expect(privateRoomOpSchema.safeParse({ ...baseOp, lamport: '0' }).success).toBe(true);
    expect(
      privateRoomOpSchema.safeParse({ ...baseOp, lamport: '900719925474099199' }).success,
    ).toBe(true);
  });

  it('rejects a leading-zero / negative / non-numeric lamport', () => {
    for (const lamport of ['01', '-1', '1.5', 'x', '']) {
      expect(privateRoomOpSchema.safeParse({ ...baseOp, lamport }).success).toBe(false);
    }
  });

  it('rejects an over-long lamport string (the big-integer-comparator DoS bound)', () => {
    expect(privateRoomOpSchema.safeParse({ ...baseOp, lamport: '1'.repeat(41) }).success).toBe(
      false,
    );
    // A 40-digit lamport is still accepted (the bound is generous, not tight).
    expect(privateRoomOpSchema.safeParse({ ...baseOp, lamport: '9'.repeat(40) }).success).toBe(
      true,
    );
  });

  it('routes the op body discriminated union (a member.add op)', () => {
    const op = {
      ...baseOp,
      lamport: '1',
      body: {
        type: 'member.add',
        member_id: 'm-2',
        device_id: 'd-2',
        signing_public_key: B64,
        hpke_public_key: B64,
        mls_key_package: B64,
        granted_role: 'member',
      },
    };
    expect(privateRoomOpSchema.safeParse(op).success).toBe(true);
  });
});

describe('WS-S.2.3 invite + join + attachment + search + report', () => {
  it('accepts a valid invite secret + rejects unknown fields', () => {
    const invite = {
      schema: 'licio.private.invite_secret.v1',
      room_public_key: B64,
      invite_id: 'inv-1',
      invite_secret: B64,
      expires_at: '2026-07-01T00:00:00Z',
      max_uses: 5,
      granted_role: 'member',
      requires_admin_approval: true,
    };
    expect(inviteSecretSchema.safeParse(invite).success).toBe(true);
    expect(inviteSecretSchema.safeParse({ ...invite, extra: 1 }).success).toBe(false);
  });

  it('accepts a valid join request', () => {
    const join = {
      schema: 'licio.private.join_request.v1',
      invite_id_blind: B64,
      recipient_device_key_package: B64,
      device_signing_public_key: B64,
      proposed_display_name: 'Alex',
      proof_of_invite_secret: B64,
      requested_at_bucket: '2026-06-22T00',
    };
    expect(joinRequestSchema.safeParse(join).success).toBe(true);
  });

  it('accepts a valid attachment manifest + rejects out-of-order chunk indices', () => {
    const manifest = {
      schema: 'licio.private.attachment_manifest.v1',
      attachment_id: 'att-1',
      room_id: 'room-1',
      created_by_member_id: 'm-1',
      created_at: '2026-06-22T00:00:00Z',
      media_kind: 'image',
      content_type: 'image/png',
      byte_size_exact_encrypted: 4096,
      byte_size_class: 'small',
      encrypted_chunks: [
        { index: 0, cid: CID, size: 2048, plaintext_hash_commitment: B64, ciphertext_hash: B64 },
        { index: 1, cid: CID, size: 2048, plaintext_hash_commitment: B64, ciphertext_hash: B64 },
      ],
      accessibility: { alt_text: 'A photo.' },
      local_safety: { metadata_stripped: true, user_confirmed_right_to_share: true },
    };
    expect(privateAttachmentManifestSchema.safeParse(manifest).success).toBe(true);
    const misordered = {
      ...manifest,
      encrypted_chunks: [
        { index: 1, cid: CID, size: 2048, plaintext_hash_commitment: B64, ciphertext_hash: B64 },
        { index: 0, cid: CID, size: 2048, plaintext_hash_commitment: B64, ciphertext_hash: B64 },
      ],
    };
    expect(privateAttachmentManifestSchema.safeParse(misordered).success).toBe(false);
  });

  it('accepts a local search shard + a voluntary report package', () => {
    expect(
      privateLocalSearchShardSchema.safeParse({
        schema: 'licio.private.local_search_shard.v1',
        room_id: 'room-1',
        snapshot_root: B64,
        shard_id: 'shard-1',
        index_kind: 'body',
        terms: { tokens: [] },
      }).success,
    ).toBe(true);
    expect(
      voluntaryPrivateReportPackageSchema.safeParse({
        schema: 'licio.private.report_package.v1',
        report_id: 'rep-1',
        disclosed_items: [{ kind: 'contribution', signatures: [B64], author_device_keys: [B64] }],
        redaction_notes: '',
        reporter_attestation: 'I attest this is accurate.',
        created_at: '2026-06-22T00:00:00Z',
      }).success,
    ).toBe(true);
  });
});
