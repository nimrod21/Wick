// Tier-1 probe: TwelveData time_series REST endpoint.
// Requires TWELVEDATA_API_KEY env var. Short-circuits with [BLOCKED] if absent.

const started = performance.now();

interface TwelveDataValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TwelveDataResponse {
  meta?: {
    symbol?: string;
    interval?: string;
    currency_base?: string;
    currency_quote?: string;
  };
  values?: TwelveDataValue[];
  status?: string;
  code?: number;
  message?: string;
}

async function main(): Promise<void> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key || key.trim() === '') {
    console.log('[BLOCKED] signup: https://twelvedata.com/register');
    process.exit(0);
  }

  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&apikey=${encodeURIComponent(key)}&outputsize=5`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as TwelveDataResponse;

    if (data.status === 'error') {
      throw new Error(`API error: ${data.message ?? 'unknown'} (code=${data.code ?? 'n/a'})`);
    }

    const symbol = data.meta?.symbol ?? 'unknown';
    const latest = data.values?.[0];
    if (!latest) {
      throw new Error('No time_series values returned');
    }

    console.log(JSON.stringify({
      provider: 'twelvedata',
      symbol,
      latest_datetime: latest.datetime,
      latest_close: latest.close,
      bars_returned: data.values?.length ?? 0,
    }));
  } finally {
    clearTimeout(timer);
  }
}

main()
  .then(() => console.log(`[OK] elapsed=${Math.round(performance.now() - started)}ms`))
  .catch((e) => {
    console.error(`[FAIL] ${e?.message || e}`);
    process.exit(1);
  });
