// Tier-0 probe: Blockstream Esplora public API (no API key).
// Fetches tx history for Mt. Gox cold wallet and logs count + latest txid.

const started = performance.now();

const ADDRESS = "1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF";
const URL = `https://blockstream.info/api/address/${ADDRESS}/txs`;
const TIMEOUT_MS = 10_000;

interface BlockstreamTx {
  txid: string;
  status?: {
    confirmed?: boolean;
    block_height?: number;
    block_time?: number;
  };
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`http_status=${res.status} ${res.statusText}`);
    }
    const txs = (await res.json()) as BlockstreamTx[];
    const count = Array.isArray(txs) ? txs.length : 0;
    const latestTxid = count > 0 ? txs[0].txid : "none";
    const latestBlockHeight = count > 0 ? txs[0].status?.block_height ?? "unknown" : "none";
    console.log(`[probe-blockstream] address=${ADDRESS}`);
    console.log(`[probe-blockstream] tx_count=${count}`);
    console.log(`[probe-blockstream] latest_txid=${latestTxid}`);
    console.log(`[probe-blockstream] latest_block_height=${latestBlockHeight}`);
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
