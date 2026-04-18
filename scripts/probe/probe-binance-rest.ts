const started = performance.now();

type Kline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  string, // quote asset volume
  number, // number of trades
  string, // taker buy base asset volume
  string, // taker buy quote asset volume
  string, // ignore
];

async function main(): Promise<void> {
  const url = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100';
  console.log(`[probe-binance-rest] url=${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`http status=${res.status} statusText=${res.statusText}`);
    }

    const data = (await res.json()) as Kline[];
    if (!Array.isArray(data)) {
      throw new Error(`unexpected response shape: ${typeof data}`);
    }

    const count = data.length;
    const first = data[0];
    const last = data[data.length - 1];
    const earliestTs = first?.[0];
    const latestTs = last?.[0];

    console.log(
      `[probe-binance-rest] count=${count} earliestTs=${earliestTs} earliestIso=${earliestTs ? new Date(earliestTs).toISOString() : 'n/a'} latestTs=${latestTs} latestIso=${latestTs ? new Date(latestTs).toISOString() : 'n/a'}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

main()
  .then(() => console.log(`[OK] elapsed=${Math.round(performance.now() - started)}ms`))
  .catch((e) => {
    console.error(`[FAIL] ${e?.message || e}`);
    process.exit(1);
  });
