// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.1e published support contact: reachable WITHOUT authentication from
// every screen (so locked-out users can still reach support).  Emergency
// resource links are jurisdiction-appropriate when the jurisdiction is known,
// with a safe default set otherwise.  No credentials are requested; links open
// externally with the strict-CSP allowlist (the client adds rel="noopener").
import type { EmergencyResource, SupportContactResponse } from '@licio/shared';

const SAFETY_EMAIL = 'safety@licio.app';
const HELP_CENTER_URL = 'https://licio.app/help';

/** International, always-safe defaults (used when jurisdiction is unknown). */
const DEFAULT_RESOURCES: EmergencyResource[] = [
  {
    label: 'Find a crisis line near you',
    description: 'International directory of suicide and crisis hotlines.',
    url: 'https://findahelpline.com',
    phone: null,
  },
  {
    label: 'Report child sexual abuse material',
    description: 'INHOPE network of national CSAM reporting hotlines.',
    url: 'https://www.inhope.org/EN/our-members',
    phone: null,
  },
];

/** Jurisdiction-specific resource sets (ISO 3166-1 alpha-2, upper-case). */
const JURISDICTION_RESOURCES: Readonly<Record<string, EmergencyResource[]>> = {
  US: [
    {
      label: '988 Suicide & Crisis Lifeline',
      description: 'Free, confidential 24/7 support in the United States.',
      url: 'https://988lifeline.org',
      phone: '988',
    },
    {
      label: 'NCMEC CyberTipline',
      description: 'Report child sexual exploitation in the United States.',
      url: 'https://report.cybertip.org',
      phone: '1-800-843-5678',
    },
  ],
  GB: [
    {
      label: 'Samaritans',
      description: 'Free 24/7 emotional support in the UK and Ireland.',
      url: 'https://www.samaritans.org',
      phone: '116 123',
    },
  ],
};

/** Build the support-contact payload for a (possibly unknown) jurisdiction. */
export function buildSupportContact(jurisdiction: string | null): SupportContactResponse {
  const key = jurisdiction?.toUpperCase() ?? null;
  const resources =
    key && JURISDICTION_RESOURCES[key] ? JURISDICTION_RESOURCES[key] : DEFAULT_RESOURCES;
  return {
    safety_email: SAFETY_EMAIL,
    help_center_url: HELP_CENTER_URL,
    jurisdiction: key && JURISDICTION_RESOURCES[key] ? key : null,
    emergency_resources: resources,
  };
}
