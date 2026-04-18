'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface Point {
  ts: number;
  value: number;
  meta: { classification?: string } | null;
}

interface SeriesResponse {
  name: string;
  points: Point[];
}

interface Segment {
  startDeg: number;
  endDeg: number;
  color: string;
  label: string;
}

// Half-circle sweeps from 180° (left) to 360° (right).
const SEGMENTS: Segment[] = [
  { startDeg: 180, endDeg: 225, color: '#ff3864', label: 'EXTREME FEAR' },
  { startDeg: 225, endDeg: 270, color: '#ffb000', label: 'FEAR' },
  { startDeg: 270, endDeg: 315, color: '#00ffff', label: 'GREED' },
  { startDeg: 315, endDeg: 360, color: '#39ff14', label: 'EXTREME GREED' },
];

function classifyDefault(v: number): string {
  if (v < 25) return 'EXTREME FEAR';
  if (v < 50) return 'FEAR';
  if (v < 75) return 'GREED';
  return 'EXTREME GREED';
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startDeg: number,
  endDeg: number,
): string {
  const [ox1, oy1] = polar(cx, cy, rOuter, startDeg);
  const [ox2, oy2] = polar(cx, cy, rOuter, endDeg);
  const [ix1, iy1] = polar(cx, cy, rInner, endDeg);
  const [ix2, iy2] = polar(cx, cy, rInner, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${ox1.toFixed(2)} ${oy1.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${ox2.toFixed(2)} ${oy2.toFixed(2)}`,
    `L ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)}`,
    'Z',
  ].join(' ');
}

export function FearGreedGauge() {
  const { data } = useQuery<SeriesResponse>({
    queryKey: ['indicator-mini', 'fng_crypto'],
    queryFn: () => api.get<SeriesResponse>('/api/indicators/fng_crypto?limit=1'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const latest = data?.points[data.points.length - 1] ?? null;
  const value = latest && Number.isFinite(latest.value) ? latest.value : null;
  const classification =
    latest?.meta?.classification && typeof latest.meta.classification === 'string'
      ? latest.meta.classification.toUpperCase()
      : value !== null
        ? classifyDefault(value)
        : '—';

  // Needle angle: 180° at value=0, 360° at value=100.
  const clamped = value === null ? 0 : Math.max(0, Math.min(100, value));
  const needleDeg = 180 + (clamped / 100) * 180;
  const [nx, ny] = polar(100, 100, 68, needleDeg);

  // Color matching the current segment (for the central value text).
  const valueColor = (() => {
    if (value === null) return '#8888bb';
    if (value < 25) return '#ff3864';
    if (value < 50) return '#ffb000';
    if (value < 75) return '#00ffff';
    return '#39ff14';
  })();

  return (
    <div className="bg-bg-terminal border-2 border-border-dim p-3 flex flex-col items-center hover:border-neon-purple transition-colors">
      <div className="w-full flex items-center justify-between">
        <span className="pixel-font text-[10px] text-text-secondary uppercase">
          Fear &amp; Greed
        </span>
        <span className="pixel-font text-[8px] text-text-dim uppercase">Crypto</span>
      </div>
      <svg viewBox="0 0 200 120" className="w-full max-w-[240px] mt-2">
        {SEGMENTS.map((seg) => (
          <path
            key={seg.label}
            d={arcPath(100, 100, 90, 72, seg.startDeg, seg.endDeg)}
            fill={seg.color}
            opacity="0.85"
          />
        ))}
        {/* needle */}
        <line
          x1="100"
          y1="100"
          x2={nx.toFixed(2)}
          y2={ny.toFixed(2)}
          stroke="#e0e0ff"
          strokeWidth="2"
        />
        <circle cx="100" cy="100" r="4" fill="#e0e0ff" />
      </svg>
      <div className="mt-1 flex flex-col items-center">
        <span
          className="vt-font text-4xl glow"
          style={{ color: valueColor }}
        >
          {value !== null ? Math.round(value) : '—'}
        </span>
        <span
          className="pixel-font text-[9px] mt-1"
          style={{ color: valueColor }}
        >
          {classification}
        </span>
      </div>
    </div>
  );
}

export default FearGreedGauge;
