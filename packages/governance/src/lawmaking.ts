// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U lawmaking facilitation (SPEC §24.6 Stage 4; ADR-8). Deterministic,
// side-effect-free helpers the in-room agent runs UNDER its granted lawmaking
// capabilities. The agent facilitates — it never computes a vote outcome (no
// tally/weight capability exists): `attestOutcome` only restates a result the
// platform tally (`tallyElection`/`tallyRatification`) already produced.

import type {
  AttestableResult,
  OutcomeAttestation,
  ProposalInput,
  ProposalSummary,
  VoteSchedule,
} from './schemas/lawmaking.js';

const SUMMARY_BODY_CHARS = 280;
const HEADLINE_CHARS = 120;

/** A neutral, deterministic proposal summary (no LLM, no editorialising). */
export function summarizeProposal(proposal: ProposalInput): ProposalSummary {
  const headline = truncate(collapseWhitespace(proposal.title), HEADLINE_CHARS);
  const gist = truncate(collapseWhitespace(proposal.body), SUMMARY_BODY_CHARS);
  const optionCount = proposal.options.length;
  const optionLine =
    optionCount > 0 ? ` Options (${optionCount}): ${proposal.options.join('; ')}.` : '';
  const summary = `Proposal: ${headline}.${gist.length > 0 ? ` ${gist}` : ''}${optionLine}`;
  return { proposalId: proposal.proposalId, headline, optionCount, summary };
}

/** A deterministic vote window from the opening instant + a window length. */
export function scheduleProposalVote(
  proposalId: string,
  opensAtMs: number,
  windowSeconds: number,
): VoteSchedule {
  return {
    proposalId,
    opensAt: new Date(opensAtMs).toISOString(),
    closesAt: new Date(opensAtMs + windowSeconds * 1000).toISOString(),
  };
}

/**
 * Attest a PLATFORM-COMPUTED outcome (ADR-8): the agent restates a settled tally;
 * it does not, and structurally cannot, compute or weight it. An unsettled result
 * is `inconclusive` (quorum/turnout not met), never silently "rejected".
 */
export function attestOutcome(proposalId: string, result: AttestableResult): OutcomeAttestation {
  const outcome = !result.settled ? 'inconclusive' : result.adopted ? 'adopted' : 'rejected';
  const statement =
    `Attested outcome for proposal ${proposalId}: ${outcome} ` +
    `(in favour ${result.inFavor}, against ${result.against}).`;
  return { proposalId, outcome, statement };
}

/** ReDoS-free whitespace collapse + trim (no regex; SPEC §24.6 DSL discipline). */
function collapseWhitespace(text: string): string {
  const parts: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (cur.length > 0) {
        parts.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts.join(' ');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
