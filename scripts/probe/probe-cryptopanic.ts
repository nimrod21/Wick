/**
 * Tier-1 probe: CryptoPanic news aggregator.
 * Requires CRYPTOPANIC_API_KEY. Fetches hot public news posts.
 */
const started = performance.now();

const TIMEOUT_MS = 10_000;

interface CryptoPanicPost {
  title?: string;
  published_at?: string;
  url?: string;
}

interface CryptoPanicResponse {
  count?: number;
  results?: CryptoPanicPost[];
}

async function main(): Promise<void> {
  const key = process.env.CRYPTOPANIC_API_KEY;
  if (!key || key.trim() === "") {
    console.log("[BLOCKED] signup: https://cryptopanic.com/developers/api");
    return;
  }

  const url =
    `https://cryptopanic.com/api/v1/posts/` +
    `?auth_token=${encodeURIComponent(key)}&public=true&kind=news&filter=hot`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as CryptoPanicResponse;

    const posts = Array.isArray(data.results) ? data.results : [];
    const first = posts[0];
    console.log(
      JSON.stringify({
        probe: "cryptopanic",
        postCount: posts.length,
        reportedCount: typeof data.count === "number" ? data.count : null,
        firstPostTitle: first?.title ?? null,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

main()
  .then(() =>
    console.log(`[OK] elapsed=${Math.round(performance.now() - started)}ms`),
  )
  .catch((e) => {
    console.error(`[FAIL] ${e?.message || e}`);
    process.exit(1);
  });
