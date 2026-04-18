// Tier-1 probe: Finnhub company-news REST endpoint.
// Requires FINNHUB_API_KEY env var. Short-circuits with [BLOCKED] if absent.

const started = performance.now();

interface FinnhubArticle {
  category?: string;
  datetime?: number;
  headline?: string;
  id?: number;
  image?: string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
}

async function main(): Promise<void> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || key.trim() === '') {
    console.log('[BLOCKED] signup: https://finnhub.io/register');
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const url = `https://finnhub.io/api/v1/company-news?symbol=AAPL&from=${yesterday}&to=${today}&token=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as FinnhubArticle[] | { error?: string };

    if (!Array.isArray(data)) {
      throw new Error(`API error: ${data?.error ?? 'unexpected response shape'}`);
    }

    const firstHeadline = data[0]?.headline ?? null;

    console.log(JSON.stringify({
      provider: 'finnhub',
      symbol: 'AAPL',
      from: yesterday,
      to: today,
      article_count: data.length,
      first_headline: firstHeadline,
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
