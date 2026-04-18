const started = performance.now();

interface FngEntry {
  value: string;
  value_classification: string;
  timestamp: string;
  time_until_update?: string;
}

interface FngResponse {
  name?: string;
  data?: FngEntry[];
  metadata?: { error?: string | null };
}

async function main(): Promise<void> {
  const url = 'https://api.alternative.me/fng/?limit=10';
  console.log(`[probe-fng] url=${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`http status=${res.status} statusText=${res.statusText}`);
    }

    const body = (await res.json()) as FngResponse;
    const entries = body.data ?? [];
    console.log(`[probe-fng] count=${entries.length}`);

    entries.forEach((entry, idx) => {
      const tsNum = Number(entry.timestamp);
      const iso = Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : 'n/a';
      console.log(
        `[probe-fng] idx=${idx} value=${entry.value} classification=${JSON.stringify(entry.value_classification)} timestamp=${entry.timestamp} iso=${iso}`,
      );
    });
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
