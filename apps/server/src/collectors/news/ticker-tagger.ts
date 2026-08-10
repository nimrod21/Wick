/**
 * Ticker tagger — word-boundary alias matcher for news headlines.
 * Ported from the pre-reset cockpit collector, with three fixes:
 *
 *  1. Crypto only. Wick's watchlist is crypto; the old map's equity aliases
 *     ("apple", "visa", "meta") tagged headlines nothing here can trade.
 *  2. Dropped the "binance" → BNB alias. Exchange news is not BNB news, and
 *     it was the single loudest false-positive in the old feed.
 *  3. Aliases live in this module instead of a JSON file — the server build
 *     only copies `db/migrations` into dist, so a JSON import would work in
 *     dev and go missing in the pm2 build.
 *
 * Deliberately still simple: no negation handling, no NER. The tags feed a
 * per-asset average, which tolerates the occasional miss.
 */

/** base ticker → aliases (matched case-insensitively on word boundaries). */
const ALIASES: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc', 'xbt', 'satoshi'],
  ETH: ['ethereum', 'ether', 'eth', 'vitalik'],
  SOL: ['solana', 'sol'],
  BNB: ['bnb', 'binance coin', 'binance smart chain', 'bsc'],
  XRP: ['xrp', 'ripple'],
  ADA: ['cardano', 'ada', 'hoskinson'],
  LTC: ['litecoin', 'ltc'],
  DOGE: ['dogecoin', 'doge'],
  AVAX: ['avalanche', 'avax'],
  LINK: ['chainlink', 'link token'],
  DOT: ['polkadot', 'dot token'],
  TRX: ['tron', 'trx'],
  MATIC: ['polygon', 'matic'],
  TON: ['toncoin', 'ton blockchain'],
};

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledEntry {
  ticker: string;
  regex: RegExp;
}

const COMPILED: CompiledEntry[] = Object.entries(ALIASES)
  .map(([ticker, aliases]) => ({
    ticker,
    regex: new RegExp(`\\b(?:${aliases.map(escapeRegex).join('|')})\\b`, 'i'),
  }));

/** Unique base tickers referenced by `title` (+ optional `summary`). */
export function tagTickers(title: string, summary?: string): string[] {
  const haystack = `${title ?? ''} ${summary ?? ''}`.trim();
  if (haystack.length === 0) return [];
  const hits: string[] = [];
  for (const entry of COMPILED) {
    if (entry.regex.test(haystack)) hits.push(entry.ticker);
  }
  return hits;
}

export function knownTickers(): string[] {
  return COMPILED.map((e) => e.ticker);
}

/**
 * `BTCUSDT` → `BTC`. Watchlist symbols are Binance pairs; news is tagged
 * with base tickers, so the per-asset join needs this one normalisation.
 */
export function baseTicker(symbol: string): string {
  return symbol.toUpperCase().replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, '');
}
