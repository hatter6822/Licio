// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The curated report-reason catalog for the two-tap report flow (WS-J.1.1c):
// taxonomy reason codes grouped by category (safety / content quality / policy)
// with a short label and one-line description.  Every code is a ratified WS-A.1.2
// code (the server re-validates); this is UI copy for the reason selector.
import type { ModerationReasonCode } from '@licio/shared';

export interface ReportReason {
  code: ModerationReasonCode;
  label: string;
  description: string;
}

export interface ReportReasonGroup {
  group: 'safety' | 'content_quality' | 'policy';
  title: string;
  reasons: ReportReason[];
}

export const REPORT_REASON_GROUPS: ReportReasonGroup[] = [
  {
    group: 'safety',
    title: 'Safety',
    reasons: [
      {
        code: 'MOD_THREAT_001',
        label: 'Threat of violence',
        description: 'A credible threat of harm to a person.',
      },
      {
        code: 'MOD_HARASS_001',
        label: 'Harassment',
        description: 'Targeted insults or unwanted contact.',
      },
      {
        code: 'MOD_HATE_001',
        label: 'Hate speech',
        description: 'Attacks based on a protected characteristic.',
      },
      {
        code: 'MOD_GRAPHIC_002',
        label: 'Self-harm',
        description: 'Promotion or instruction of self-harm.',
      },
      {
        code: 'MOD_CSE_001',
        label: 'Child safety',
        description: 'Sexual exploitation or abuse of a minor.',
      },
      {
        code: 'MOD_PRIVACY_001',
        label: 'Doxxing / privacy',
        description: "Sharing someone's private information.",
      },
    ],
  },
  {
    group: 'content_quality',
    title: 'Content quality',
    reasons: [
      {
        code: 'MOD_SPAM_001',
        label: 'Spam',
        description: 'Automated or repetitive promotional content.',
      },
      {
        code: 'MOD_MISINFO_001',
        label: 'Misinformation',
        description: 'A provably false claim that may cause harm.',
      },
      {
        code: 'MOD_SYNTH_001',
        label: 'Undisclosed synthetic media',
        description: 'AI-generated media presented as real.',
      },
    ],
  },
  {
    group: 'policy',
    title: 'Policy',
    reasons: [
      {
        code: 'MOD_IMPERS_001',
        label: 'Impersonation',
        description: 'Pretending to be someone else.',
      },
      {
        code: 'MOD_IP_001',
        label: 'Intellectual property',
        description: 'A copyright or trademark concern.',
      },
      {
        code: 'MOD_ILLEGAL_001',
        label: 'Illegal content',
        description: 'Content that violates applicable law.',
      },
    ],
  },
];

/** Flat lookup of every reason in the catalog by code. */
export const REPORT_REASONS_BY_CODE: ReadonlyMap<string, ReportReason> = new Map(
  REPORT_REASON_GROUPS.flatMap((g) => g.reasons.map((r) => [r.code, r] as const)),
);
