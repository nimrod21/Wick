/**
 * Sentiment scorer — lexicon-based, -1..+1.
 *
 * Loads the positive/negative word lists from `data/sentiment-lexicon.json`,
 * compiles a case-insensitive word-boundary regex, counts hits, returns
 * `(pos - neg) / max(pos + neg, 1)`. When both counts are zero we return
 * `null` so the UI can render neutral-gray instead of a false zero.
 */

import lexicon from '../../data/sentiment-lexicon.json' with { type: 'json' };

interface Lexicon {
  positive: string[];
  negative: string[];
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(words: string[]): RegExp | null {
  const escaped = words
    .filter((w) => typeof w === 'string' && w.length > 0)
    .map((w) => escapeRegex(w));
  if (escaped.length === 0) return null;
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
}

const lex = lexicon as Lexicon;
const POS_RE = buildRegex(lex.positive ?? []);
const NEG_RE = buildRegex(lex.negative ?? []);

function countMatches(haystack: string, re: RegExp | null): number {
  if (!re) return 0;
  re.lastIndex = 0;
  const matches = haystack.match(re);
  return matches ? matches.length : 0;
}

/**
 * Score sentiment in `-1..+1`, or `null` when no lexicon words appear.
 */
export function scoreSentiment(
  title: string,
  summary?: string,
): number | null {
  const haystack = `${title ?? ''} ${summary ?? ''}`.trim();
  if (haystack.length === 0) return null;
  const pos = countMatches(haystack, POS_RE);
  const neg = countMatches(haystack, NEG_RE);
  if (pos === 0 && neg === 0) return null;
  const score = (pos - neg) / Math.max(pos + neg, 1);
  // Clamp to [-1, +1] defensively.
  if (score > 1) return 1;
  if (score < -1) return -1;
  return score;
}
