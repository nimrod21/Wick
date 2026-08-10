/**
 * BTC whale watchlist — the `seed/whale_addresses.json` BTC entries from the
 * pre-reset cockpit, carried over as a TS const (the server build only copies
 * `db/migrations` into dist, so a JSON seed would go missing under pm2).
 *
 * `exchange: true` marks a wallet whose flows are read directionally:
 * coins arriving = inflow (bearish), coins leaving = outflow (bullish).
 * Everything else (Mt Gox estates, early-miner wallets, frozen hack funds)
 * is still watched and logged, but its moves are recorded as 'internal' —
 * they are whale activity, not exchange flow, and must not vote.
 *
 * ETH and SOL entries from the same seed are intentionally NOT here: those
 * chains need Etherscan / Helius keys and are a later session.
 *
 * Dropped from the seed: `bc1qjasf9z3h7w3jspkhtgatgpyvvzgpa2wwd2lr0e`
 * ("Coinbase cold (historical)") — both Esplora backends reject it as a
 * malformed address (HTTP 400). Verified 2026-08-10.
 *
 * KNOWN LIMITATION (measured 2026-08-10): every exchange entry below is a
 * COLD wallet and they move in monthly lumps — Kraken last moved 2026-06-12,
 * and the last 25 confirmed txs on the Binance / Robinhood / OKX entries are
 * all dust spam, so their real movements never even reach the Esplora page
 * window. `whale_flow` therefore reads null (→ neutral) much of the time.
 * The fix is better seed data — live exchange HOT wallets, or the ETH/SOL
 * collectors once their keys exist — not more collector code.
 */

export interface WhaleAddress {
  address: string;
  label: string;
  exchange: boolean;
}

export const BTC_WHALE_ADDRESSES: WhaleAddress[] = [
  { address: 'bc1qa5wkgaew2dkv56kfvj49j0av5nml45x9ek9hz6', label: 'Binance cold 1', exchange: true },
  { address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', label: 'Binance cold (legacy)', exchange: true },
  { address: 'bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2', label: 'Kraken cold', exchange: true },
  { address: 'bc1qazcm763858nkj2dj986etajv6wquslv8uxwczt', label: 'Robinhood BTC cold', exchange: true },
  { address: 'bc1q7ydrtdn8z62xhslqyqtyt38mm4e2c4h3mxjkug', label: 'OKX cold', exchange: true },
  { address: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97', label: 'Bitfinex hack (frozen)', exchange: false },
  { address: '3LYJfcfHPXYJreMsASk2jkn69LWEYKzexb', label: 'Bitfinex hack funds', exchange: false },
  { address: '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF', label: 'Mt Gox cold (?)', exchange: false },
  { address: '1HQ3Go3ggs8pFnXuHVHRytPCq5fGG8Hbhx', label: 'Mt Gox trustee wallet', exchange: false },
  { address: '1P5ZEDWTKTFGxQjZphgWPQUpe554WKDfHQ', label: 'Unknown early miner', exchange: false },
  { address: '12ib7dApVFvg82TXKycWBNpN8kFyiAN1dr', label: '1Feex sibling', exchange: false },
  { address: '1LdRcdxfbSnmCYYNdeYpUnztiYzVfBEQeC', label: 'Satoshi candidate #2', exchange: false },
  { address: '1AC4fMwgY8j9onSbXEWeH6Zan8QGMSdmtA', label: 'Unknown OG miner', exchange: false },
  { address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', label: 'Generic whale', exchange: false },
];

/** address → seed entry, for counterpart lookups. */
export const BTC_WHALE_BY_ADDRESS = new Map(
  BTC_WHALE_ADDRESSES.map((a) => [a.address, a] as const),
);
