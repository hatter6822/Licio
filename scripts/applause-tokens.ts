// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The applause vocabulary — ONE list, two gates.
//
// SPEC §2.4/§5.1 ("no likes, votes, karma, follower counts, or reaction bars")
// was enumerated TWICE, in two different vocabularies:
//
//   • `check-lcap-schema-egress.ts` spelled it as TOKENS matched by set
//     membership against parsed schema field names, covering both
//     `like_count` and `likeCount`;
//   • `check-no-applause.ts` spelled it as REGEXES that only ever matched
//     camelCase (`/\b(?:like|vote|…)Count\b/`) plus `\b(?:up|down)votes?\b`.
//
// This codebase's wire contract is snake_case throughout
// (`author_handle`, `target_claim_id`, …), so a component rendering
// `story.like_count` matched neither pattern in the second gate: `…Count` is
// camelCase-only, and `\bupvotes?\b` cannot match inside `upvote_count`
// because `_` is a word character, so there is no boundary before it.
// The doctrine gate CLAUDE.md calls ABSOLUTE was blind to the spelling the
// codebase actually uses.
//
// One list, imported by both — the same SSOT idiom
// `scripts/dangerous-code-patterns.ts` uses for the dynamic-code sinks.
// Adding a spelling here arms BOTH gates, which is the property that was
// missing.

/**
 * Field/identifier spellings that denote applause.
 *
 * Both casings of every compound are listed explicitly rather than derived:
 * the schema gate matches these by exact set membership against a parsed field
 * name, so a generated variant would have to round-trip through the same
 * transformation to stay a valid member, and a list you can read is worth more
 * here than one you have to execute.
 */
export const APPLAUSE_TOKENS: readonly string[] = [
  'like_count',
  'likeCount',
  'likes',
  'vote_count',
  'voteCount',
  'upvote',
  'upvotes',
  'upvote_count',
  'upvoteCount',
  'downvote',
  'downvotes',
  'downvote_count',
  'downvoteCount',
  'karma',
  'reaction_count',
  'reactionCount',
  'reactions',
  'follower_count',
  'followerCount',
  'followers',
  'score_count',
  'star_count',
  'star_rating',
  'starRating',
  'share_count',
  'shareCount',
];

/**
 * The same vocabulary as whole-word regexes, for the gates that scan SOURCE
 * TEXT rather than parsed schema fields.
 *
 * `\b` on both sides so `like_count` matches as a field but `unlike_counter`
 * does not, and so a longer identifier that merely CONTAINS a token is not a
 * finding.  Case-sensitive on purpose: the camelCase and snake_case spellings
 * are both listed above, and a case-insensitive match would turn the prose word
 * "Likes" in a rendered string into a false positive that trains people to
 * weaken the gate.
 */
export const APPLAUSE_TOKEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; message: string }> =
  APPLAUSE_TOKENS.map((token) => ({
    pattern: new RegExp(`\\b${token}\\b`),
    message: `applause field/identifier \`${token}\``,
  }));
