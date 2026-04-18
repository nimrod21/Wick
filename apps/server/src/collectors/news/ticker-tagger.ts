/**
 * Ticker tagger — word-boundary alias matcher for news items.
 *
 * Loads `data/ticker-aliases.json` at module init, pre-compiles a
 * case-insensitive regex per ticker, and returns the unique set of
 * tickers referenced by the provided title + summary text.
 *
 * Intentionally simple: no negation handling, no NER. MVP scope.
 */

import aliasMap from '../../data/ticker-aliases.json' with { type: 'json' };

type AliasMap = Record<string, string[]>;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledEntry {
  ticker: string;
  regex: RegExp;
}

function compile(map: AliasMap): CompiledEntry[] {
  const out: CompiledEntry[] = [];
  for (const [ticker, aliases] of Object.entries(map)) {
    if (!Array.isArray(aliases) || aliases.length === 0) continue;
    const escaped = aliases
      .filter((a) => typeof a === 'string' && a.length > 0)
      .map((a) => escapeRegex(a));
    if (escaped.length === 0) continue;
    // Word-boundary match, case-insensitive, global so we can evaluate
    // on the concatenated haystack in one pass.
    out.push({
      ticker,
      regex: new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i'),
    });
  }
  return out;
}

const COMPILED: CompiledEntry[] = compile(aliasMap as AliasMap);

/**
 * Return the unique list of tickers that appear (by alias) in the
 * provided title and optional summary. Order matches the order of
 * entries in the alias map.
 */
export function tagTickers(title: string, summary?: string): string[] {
  if (!title && !summary) return [];
  const haystack = `${title ?? ''} ${summary ?? ''}`;
  if (haystack.trim().length === 0) return [];
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const entry of COMPILED) {
    if (seen.has(entry.ticker)) continue;
    if (entry.regex.test(haystack)) {
      hits.push(entry.ticker);
      seen.add(entry.ticker);
    }
  }
  return hits;
}

export function knownTickers(): string[] {
  return COMPILED.map((e) => e.ticker);
}
