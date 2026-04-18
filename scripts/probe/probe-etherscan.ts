/**
 * Tier-1 probe: Etherscan
 * Requires ETHERSCAN_API_KEY. Fetches recent txs for vitalik.eth.
 */
const started = performance.now();

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth
const TIMEOUT_MS = 10_000;

interface EtherscanTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
}

interface EtherscanResponse {
  status: string;
  message: string;
  result: EtherscanTx[] | string;
}

async function main(): Promise<void> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key || key.trim() === "") {
    console.log("[BLOCKED] signup: https://etherscan.io/register");
    return;
  }

  const url =
    `https://api.etherscan.io/api?module=account&action=txlist` +
    `&address=${ADDRESS}&startblock=0&endblock=99999999` +
    `&page=1&offset=5&sort=desc&apikey=${encodeURIComponent(key)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as EtherscanResponse;

    if (data.status !== "1" || !Array.isArray(data.result)) {
      console.log(
        JSON.stringify({
          probe: "etherscan",
          status: "non_ok_response",
          apiStatus: data.status,
          apiMessage: data.message,
          result: typeof data.result === "string" ? data.result : null,
        }),
      );
      return;
    }

    const txs = data.result;
    const latest = txs[0];
    console.log(
      JSON.stringify({
        probe: "etherscan",
        address: ADDRESS,
        txCount: txs.length,
        latestTxHash: latest?.hash ?? null,
        latestBlockNumber: latest?.blockNumber ?? null,
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
