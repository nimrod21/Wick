// Tier-1 probe: Alpaca paper-trading account REST endpoint.
// Requires ALPACA_API_KEY and ALPACA_API_SECRET env vars. Short-circuits with [BLOCKED] if either absent.

const started = performance.now();

interface AlpacaAccount {
  id?: string;
  account_number?: string;
  status?: string;
  buying_power?: string;
  cash?: string;
  currency?: string;
  equity?: string;
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || key.trim() === '' || !secret || secret.trim() === '') {
    console.log('[BLOCKED] signup: https://alpaca.markets/paper');
    process.exit(0);
  }

  const url = 'https://paper-api.alpaca.markets/v2/account';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` body=${body.slice(0, 200)}` : ''}`);
    }
    const data = (await res.json()) as AlpacaAccount;

    console.log(JSON.stringify({
      provider: 'alpaca',
      account_id: data.id ?? null,
      status: data.status ?? null,
      buying_power: data.buying_power ?? null,
      currency: data.currency ?? null,
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
