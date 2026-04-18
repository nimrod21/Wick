'use client';

import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface Asset {
  id: number;
  symbol: string;
  displayName: string;
  type: string;
  enabled: boolean;
}

interface AssetsResponse {
  assets: Asset[];
}

interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CandlesResponse {
  candles: Candle[];
}

function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function Sparkline({ candles }: { candles: Candle[] }) {
  if (candles.length < 2) {
    return (
      <svg viewBox="0 0 100 30" className="w-full h-8" preserveAspectRatio="none">
        <line x1="0" y1="15" x2="100" y2="15" stroke="#55557a" strokeWidth="1" />
      </svg>
    );
  }
  const closes = candles.map((c) => c.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const n = candles.length;
  const isUp = closes[closes.length - 1]! >= closes[0]!;
  const stroke = isUp ? '#39ff14' : '#ff3864';
  const points = closes
    .map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 30 - ((v - min) / span) * 28 - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg viewBox="0 0 100 30" className="w-full h-8" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.4" />
    </svg>
  );
}

function Cell({ asset }: { asset: Asset }) {
  const router = useRouter();
  const { data } = useQuery<CandlesResponse>({
    queryKey: ['dashboard-candles', asset.id],
    queryFn: () =>
      api.get<CandlesResponse>(
        `/api/candles?assetId=${asset.id}&timeframe=1h&limit=24`,
      ),
    refetchInterval: 60_000,
  });

  const candles = data?.candles ?? [];
  const last = candles[candles.length - 1]?.c ?? null;
  const first = candles[0]?.c ?? null;
  const pctChange =
    last !== null && first !== null && first > 0
      ? ((last - first) / first) * 100
      : null;

  return (
    <button
      type="button"
      onClick={() => router.push('/trading/crypto')}
      className="block w-full text-left bg-bg-terminal border-2 border-border-dim hover:border-neon-cyan p-2 transition-colors"
    >
      <div className="flex items-baseline justify-between">
        <span className="pixel-font text-[10px] text-neon-cyan glow">{asset.symbol}</span>
        <span
          className={`vt-font text-sm ${
            pctChange === null
              ? 'text-text-dim'
              : pctChange >= 0
                ? 'text-neon-green'
                : 'text-neon-red'
          }`}
        >
          {pctChange === null
            ? '—'
            : `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%`}
        </span>
      </div>
      <div className="mt-1 vt-font text-xl text-text-primary glow">{fmtPrice(last)}</div>
      <div className="mt-1">
        <Sparkline candles={candles} />
      </div>
    </button>
  );
}

export function MiniChartGrid() {
  const { data } = useQuery<AssetsResponse>({
    queryKey: ['dashboard-assets-crypto'],
    queryFn: () => api.get<AssetsResponse>('/api/assets?type=crypto'),
    staleTime: 5 * 60_000,
  });
  const assets = (data?.assets ?? []).filter((a) => a.enabled);

  if (assets.length === 0) {
    return (
      <div className="bg-bg-terminal border-2 border-border-dim p-3">
        <span className="vt-font text-text-dim">No crypto assets available.</span>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
      {assets.map((a) => (
        <Cell key={a.id} asset={a} />
      ))}
    </div>
  );
}

export default MiniChartGrid;
