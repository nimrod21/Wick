/**
 * Tier-1 probe: Helius (Solana RPC/enhanced API).
 * Requires HELIUS_API_KEY. Goal: verify auth works.
 */
const started = performance.now();

// Arbitrary known-valid base58 Solana pubkey. If the address itself errors,
// we still learn whether auth passed — that's the probe goal.
const ADDRESS = "3Ndfk1pPcLGqE7rwWRm8LL2ZQ4cXkHzLXhS8y5kPmS5r";
const TIMEOUT_MS = 10_000;

interface HeliusTx {
  signature?: string;
  slot?: number;
  timestamp?: number;
}

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  if (!key || key.trim() === "") {
    console.log("[BLOCKED] signup: https://helius.dev");
    return;
  }

  const url =
    `https://api.helius.xyz/v0/addresses/${ADDRESS}/transactions` +
    `?api-key=${encodeURIComponent(key)}&limit=5`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(
        JSON.stringify({
          probe: "helius",
          status: "http_error",
          httpStatus: res.status,
          body: body.slice(0, 300),
        }),
      );
      return;
    }
    const data = (await res.json()) as HeliusTx[] | { error?: string };

    if (!Array.isArray(data)) {
      console.log(
        JSON.stringify({
          probe: "helius",
          status: "non_array_response",
          error: (data as { error?: string })?.error ?? null,
        }),
      );
      return;
    }

    const latest = data[0];
    console.log(
      JSON.stringify({
        probe: "helius",
        address: ADDRESS,
        txCount: data.length,
        latestSignature: latest?.signature ?? null,
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
