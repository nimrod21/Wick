// Tier-0 probe: Yahoo Finance via yahoo-finance2 (no API key).
// Fetches quotes for VIX, DXY, AAPL — logs regularMarketPrice + regularMarketTime.

import yahooFinance from "yahoo-finance2";

const started = performance.now();

const SYMBOLS = ["^VIX", "DX-Y.NYB", "AAPL"] as const;

async function main(): Promise<void> {
  // Silence the library's "survey" notice in non-interactive runs.
  try {
    yahooFinance.suppressNotices?.(["yahooSurvey"]);
  } catch {
    // older versions may not expose suppressNotices — ignore.
  }

  for (const symbol of SYMBOLS) {
    try {
      const quote = await yahooFinance.quote(symbol);
      const price = quote?.regularMarketPrice ?? "unknown";
      const timeRaw = quote?.regularMarketTime;
      let timeIso: string;
      if (timeRaw instanceof Date) {
        timeIso = timeRaw.toISOString();
      } else if (typeof timeRaw === "number") {
        // Historically returned as unix seconds.
        timeIso = new Date(timeRaw * 1000).toISOString();
      } else if (typeof timeRaw === "string") {
        timeIso = timeRaw;
      } else {
        timeIso = "unknown";
      }
      console.log(
        `[probe-yahoo] symbol=${symbol} price=${price} time=${timeIso}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[probe-yahoo] symbol=${symbol} error=${msg}`);
      throw err;
    }
  }
}

main()
  .then(() => console.log(`[OK] elapsed=${Math.round(performance.now() - started)}ms`))
  .catch((e) => {
    console.error(`[FAIL] ${e?.message || e}`);
    process.exit(1);
  });
