/**
 * Tier-1 probe: FRED (Federal Reserve Economic Data).
 * Requires FRED_API_KEY. Fetches recent CPIAUCSL observations.
 */
const started = performance.now();

const SERIES_ID = "CPIAUCSL";
const TIMEOUT_MS = 10_000;

interface FredObservation {
  date: string;
  value: string;
}

interface FredResponse {
  observations?: FredObservation[];
  count?: number;
  error_code?: number;
  error_message?: string;
}

async function main(): Promise<void> {
  const key = process.env.FRED_API_KEY;
  if (!key || key.trim() === "") {
    console.log(
      "[BLOCKED] signup: https://fred.stlouisfed.org/docs/api/api_key.html",
    );
    return;
  }

  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${SERIES_ID}&api_key=${encodeURIComponent(key)}` +
    `&sort_order=desc&limit=5&file_type=json`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as FredResponse;

    if (data.error_code) {
      console.log(
        JSON.stringify({
          probe: "fred",
          status: "api_error",
          errorCode: data.error_code,
          errorMessage: data.error_message,
        }),
      );
      return;
    }

    const obs = Array.isArray(data.observations) ? data.observations : [];
    const latest = obs[0];
    console.log(
      JSON.stringify({
        probe: "fred",
        seriesId: SERIES_ID,
        observationCount: obs.length,
        latestDate: latest?.date ?? null,
        latestValue: latest?.value ?? null,
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
