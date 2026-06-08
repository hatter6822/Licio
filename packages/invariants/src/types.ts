// SPDX-License-Identifier: AGPL-3.0-or-later
export enum InvariantType {
  MERI = 'MERI',
  MFCI = 'MFCI',
  GWEI = 'GWEI',
  SCOI = 'SCOI',
  PHI = 'PHI',
}

export interface InvariantVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface InvariantOutput {
  type: InvariantType;
  version: InvariantVersion;
  confidence: number;
  coverage: number;
  reasonCodes: string[];
  fallbackBehavior: 'degrade-gracefully' | 'fail-open' | 'fail-closed';
  timestamp: string;
  metadata?: Record<string, unknown>;
}
