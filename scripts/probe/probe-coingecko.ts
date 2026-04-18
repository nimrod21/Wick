// Tier-0 probe: CoinGecko public API (no API key).
// Fetches global market stats + BTC spot price.

const started = performance.now();

const GLOBAL_URL = "https://api.coingecko.com/api/v3/global";
const PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
const TIMEOUT_MS = 10_000;

interface CoinGeckoGlobalResponse {
  data: {
    active_cryptocurrencies: number;
    market_cap_percentage: Record<string, number>;
  };
}

interface CoinGeckoSimplePriceResponse {
  bitcoin: { usd: number };
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`http_status=${res.status} ${res.statusText} url=${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const global = await fetchJson<CoinGeckoGlobalResponse>(GLOBAL_URL);
  const btcDominance = global.data.market_cap_percentage.btc;
  const activeCoins = global.data.active_cryptocurrencies;
  console.log(`[probe-coingecko] btc_dominance=${btcDominance}`);
  console.log(`[probe-coingecko] active_cryptocurrencies=${activeCoins}`);

  const price = await fetchJson<CoinGeckoSimplePriceResponse>(PRICE_URL);
  const btcUsd = price.bitcoin.usd;
  console.log(`[probe-coingecko] btc_usd=${btcUsd}`);
}

main()
  .then(() => console.log(`[OK] elapsed=${Math.round(performance.now() - started)}ms`))
  .catch((e) => {
    console.error(`[FAIL] ${e?.message || e}`);
    process.exit(1);
  });
