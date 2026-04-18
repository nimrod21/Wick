import Parser from 'rss-parser';

const started = performance.now();

const FEEDS: Array<{ name: string; url: string }> = [
  { name: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'reuters-business', url: 'https://feeds.reuters.com/reuters/businessNews' },
  { name: 'bloomberg-markets', url: 'https://feeds.bloomberg.com/markets/news.rss' },
];

async function fetchFeed(parser: Parser, name: string, url: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some feeds reject default fetch UA
        'user-agent': 'Mozilla/5.0 (probe-rss) AppleWebKit/537.36',
        accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`http status=${res.status} statusText=${res.statusText}`);
    }
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    const items = feed.items ?? [];
    const latest = items[0];
    console.log(
      `[probe-rss] feed=${name} items=${items.length} latestTitle=${JSON.stringify(latest?.title ?? null)} latestPubDate=${JSON.stringify(latest?.pubDate ?? latest?.isoDate ?? null)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[probe-rss] feed=${name} error=${JSON.stringify(msg)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const parser = new Parser();
  for (const { name, url } of FEEDS) {
    // Sequential so logs stay readable; total budget ~30s worst case.
    // eslint-disable-next-line no-await-in-loop
    await fetchFeed(parser, name, url);
  }
}

main()
  .then(() => console.log(`[OK] elapsed=${Math.round(performance.now() - started)}ms`))
  .catch((e) => {
    console.error(`[FAIL] ${e?.message || e}`);
    process.exit(1);
  });
