/**
 * Headline sentiment — lexicon scorer, -1..+1. Ported from the pre-reset
 * cockpit collector with the word lists widened and two real bugs fixed:
 *
 *  1. "sec" is gone from the negative list. It is an institution, not a
 *     sentiment: "SEC approves spot ETF" scored NEGATIVE in the old build.
 *  2. A negator immediately before a lexicon word ("no crash", "denies
 *     hack", "fails to rally") now flips that word's polarity, which is the
 *     cheapest fix for the most common headline construction.
 *  3. The bare colours "red"/"green" are out. They read as market direction
 *     about half the time and as plain English the rest ("Bitcoin Red Team
 *     founder…" scored −1.0 on a live headline during the build).
 *
 * Returns null when no lexicon word appears at all — the caller stores NULL
 * rather than a false 0.0, so "no read" and "balanced read" stay different.
 *
 * TODO (later session): batch-score headlines through the existing free-LLM
 * router (1 call / 15 min) and keep this lexicon as the offline fallback.
 * The stored column is already a plain REAL, so that swap needs no schema
 * change.
 */

const POSITIVE = [
  'surge', 'surges', 'rally', 'rallies', 'bullish', 'soar', 'soars', 'jump', 'jumps',
  'breakthrough', 'upgrade', 'upgraded', 'beat', 'beats', 'record', 'record high',
  'all-time high', 'approve', 'approves', 'approved', 'approval', 'launch', 'launches',
  'adopt', 'adopts', 'adoption', 'partnership', 'milestone', 'inflows', 'accumulate',
  'accumulation', 'gain', 'gains', 'climb', 'climbs', 'rebound', 'recovery',
  'outperform', 'bullrun', 'breakout', 'optimism', 'wins', 'boost', 'boosts',
];

const NEGATIVE = [
  'crash', 'crashes', 'plunge', 'plunges', 'bearish', 'drop', 'drops', 'fall', 'falls',
  'dump', 'dumps', 'hack', 'hacked', 'exploit', 'exploited', 'banned', 'ban', 'bans',
  'lawsuit', 'sued', 'downgrade', 'downgraded', 'miss', 'misses', 'probe', 'seize',
  'seized', 'outflows', 'liquidation', 'liquidations', 'selloff', 'sell-off', 'slump',
  'slumps', 'tumble', 'tumbles', 'sink', 'sinks', 'fraud', 'scam', 'rug pull', 'halt',
  'halted', 'delist', 'delisted', 'bankruptcy', 'insolvent', 'fear', 'warning', 'warns',
  'collapse', 'collapses', 'plummet', 'plummets',
];

/** Words that invert the polarity of the lexicon word right after them. */
const NEGATORS = new Set([
  'no', 'not', 'never', 'without', 'denies', 'denied', 'deny', 'avoids', 'avoided',
  'halts', 'stops', 'fails', 'failed', 'unlikely', 'anti',
]);

const POS = new Set(POSITIVE);
const NEG = new Set(NEGATIVE);

/** Longest multi-word entries, so "all-time high" is matched before "high". */
const PHRASES: Array<{ phrase: string; polarity: 1 | -1 }> = [
  ...POSITIVE.filter((w) => w.includes(' ')).map((w) => ({ phrase: w, polarity: 1 as const })),
  ...NEGATIVE.filter((w) => w.includes(' ')).map((w) => ({ phrase: w, polarity: -1 as const })),
].sort((a, b) => b.phrase.length - a.phrase.length);

/** Split into lowercase word tokens; hyphens kept (sell-off, all-time). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Score `title` (+ optional `summary`) in [-1, +1], or null when no lexicon
 * word appears.
 */
export function scoreSentiment(title: string, summary?: string): number | null {
  const raw = `${title ?? ''} ${summary ?? ''}`.trim();
  if (raw.length === 0) return null;
  const lower = raw.toLowerCase();

  let pos = 0;
  let neg = 0;

  // Multi-word entries first, then blank them out so their component words
  // are not double-counted by the token pass.
  let residual = lower;
  for (const { phrase, polarity } of PHRASES) {
    let idx = residual.indexOf(phrase);
    while (idx !== -1) {
      if (polarity === 1) pos++;
      else neg++;
      residual = residual.slice(0, idx) + ' '.repeat(phrase.length) + residual.slice(idx + phrase.length);
      idx = residual.indexOf(phrase);
    }
  }

  const tokens = tokenize(residual);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!;
    const isPos = POS.has(word);
    const isNeg = NEG.has(word);
    if (!isPos && !isNeg) continue;
    const negated = i > 0 && NEGATORS.has(tokens[i - 1]!);
    const positive = negated ? !isPos : isPos;
    if (positive) pos++;
    else neg++;
  }

  if (pos === 0 && neg === 0) return null;
  const score = (pos - neg) / (pos + neg);
  return Math.max(-1, Math.min(1, score));
}
