import WebSocket from 'ws';

const started = performance.now();

async function main(): Promise<void> {
  const url = 'wss://stream.binance.com:9443/ws/btcusdt@kline_1m';
  console.log(`[probe-binance-ws] url=${url}`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let received = 0;
    const target = 10;

    const timeout = setTimeout(() => {
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error(`timeout after 15000ms, received=${received}`));
    }, 15000);

    ws.on('open', () => {
      console.log('[probe-binance-ws] event=open');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      received += 1;
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf8');
        const parsed = JSON.parse(raw) as {
          k?: { t?: number; T?: number; s?: string; i?: string; o?: string; c?: string; x?: boolean };
          E?: number;
        };
        const k = parsed.k;
        console.log(
          `[probe-binance-ws] msg=${received}/${target} symbol=${k?.s ?? '?'} interval=${k?.i ?? '?'} openTime=${k?.t ?? '?'} closeTime=${k?.T ?? '?'} open=${k?.o ?? '?'} close=${k?.c ?? '?'} final=${k?.x ?? '?'}`,
        );
      } catch (err) {
        console.log(`[probe-binance-ws] msg=${received}/${target} parseError=${(err as Error).message}`);
      }

      if (received >= target) {
        clearTimeout(timeout);
        ws.removeAllListeners('message');
        ws.close(1000, 'done');
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log(`[probe-binance-ws] event=close code=${code} reason=${reason.toString('utf8') || 'none'} received=${received}`);
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

main()
  .then(() => console.log(`[OK] elapsed=${Math.round(performance.now() - started)}ms`))
  .catch((e) => {
    console.error(`[FAIL] ${e?.message || e}`);
    process.exit(1);
  });
