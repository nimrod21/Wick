import type { ReactNode } from 'react';

export { Panel } from './Panel';

/** Bot lifecycle light. Solid — never blinks (task 6.1). */
export function StatusLed({
  status,
  label = false,
}: {
  status: 'running' | 'stopped' | 'busted';
  label?: boolean;
}) {
  const color =
    status === 'running' ? 'bg-green' : status === 'stopped' ? 'bg-amber' : 'bg-red';
  const text =
    status === 'running' ? 'text-green' : status === 'stopped' ? 'text-amber' : 'text-red';
  return (
    <span className="inline-flex items-center gap-1.5" title={status}>
      <span className={`inline-block h-2 w-2 ${color}`} aria-hidden />
      <span className="sr-only">{status}</span>
      {label && <span className={`text-[11px] uppercase ${text}`}>{status}</span>}
    </span>
  );
}

/** Label above a value. The whole UI is stats; this is the unit. */
export function Stat({
  label,
  value,
  sub,
  valueClass = '',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`tnum truncate text-sm ${valueClass}`}>{value}</div>
      {sub !== undefined && <div className="tnum text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

/** Inline SVG sparkline — no chart library (task 6.1). */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  className = '',
  label = 'equity sparkline',
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Screen-reader name — override when the series is not equity. */
  label?: string;
}) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} className={className} role="img" aria-label="no data">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--border)"
          strokeWidth={1}
        />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const y = (v: number): number => height - 1 - ((v - min) / span) * (height - 2);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const up = values[values.length - 1]! >= values[0]!;
  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path d={d} fill="none" stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth={1} />
    </svg>
  );
}

/** buy green / sell red / wait amber / vetoed gray outline (task 6.1). */
export function ActionBadge({ action, status }: { action: string; status?: string }) {
  if (status === 'vetoed') {
    return (
      <span className="inline-block border border-line px-1 text-[10px] uppercase text-muted">
        {action} ✕
      </span>
    );
  }
  if (status === 'llm_failed') {
    return (
      <span className="inline-block border border-line px-1 text-[10px] uppercase text-muted">
        failed
      </span>
    );
  }
  const cls =
    action === 'buy'
      ? 'border-green text-green'
      : action === 'sell'
        ? 'border-red text-red'
        : 'border-amber text-amber';
  return (
    <span className={`inline-block border px-1 text-[10px] uppercase ${cls}`}>{action}</span>
  );
}

/** Score-colored outcome chip. score ∈ [-1,1]; null = not evaluated yet. */
export function OutcomeBadge({
  horizon,
  score,
  fwdRetPct,
}: {
  horizon: string;
  score: number | null;
  fwdRetPct?: number | null;
}) {
  if (score === null) {
    return (
      <span className="inline-block border border-line px-1 text-[10px] text-muted" title="not evaluated yet">
        {horizon} —
      </span>
    );
  }
  const cls = score > 0.05 ? 'border-green text-green' : score < -0.05 ? 'border-red text-red' : 'border-line text-muted';
  return (
    <span
      className={`tnum inline-block border px-1 text-[10px] ${cls}`}
      title={fwdRetPct === null || fwdRetPct === undefined ? undefined : `fwd ${fwdRetPct.toFixed(2)}%`}
    >
      {horizon} {score > 0 ? '+' : ''}
      {score.toFixed(2)}
    </span>
  );
}

/** Pixel font, page titles + bot names ONLY, small sizes (PLAN §12). */
export function PixelTitle({
  children,
  as: Tag = 'h1',
  className = '',
}: {
  children: ReactNode;
  as?: 'h1' | 'h2' | 'span';
  className?: string;
}) {
  return <Tag className={`pixel-font text-[13px] ${className}`}>{children}</Tag>;
}

/** Weight bar for the indicator stats table. Weight range is [0.25, 2.0]. */
export function WeightBar({ weight }: { weight: number }) {
  const frac = Math.max(0, Math.min(1, weight / 2));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-1.5 w-16 bg-line" aria-hidden>
        <span
          className={`block h-full ${weight >= 1 ? 'bg-green' : 'bg-amber'}`}
          style={{ width: `${frac * 100}%` }}
        />
      </span>
      <span className="tnum text-xs">{weight.toFixed(2)}</span>
    </span>
  );
}

/** Usage / quota bar (settings). */
export function UsageBar({ used, limit }: { used: number; limit: number }) {
  const frac = limit > 0 ? Math.max(0, Math.min(1, used / limit)) : 0;
  const color = frac >= 1 ? 'bg-red' : frac > 0.8 ? 'bg-amber' : 'bg-green';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-1.5 w-24 bg-line" aria-hidden>
        <span className={`block h-full ${color}`} style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="tnum text-xs text-muted">
        {used}/{limit}
      </span>
    </span>
  );
}

/** Square, hard-bordered button. Accent only on the primary variant. */
export function Btn({
  children,
  onClick,
  disabled,
  tone = 'default',
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'go' | 'warn' | 'danger';
  type?: 'button' | 'submit';
  title?: string;
}) {
  const tones = {
    default: 'border-line text-fg hover:border-cyan hover:text-cyan',
    go: 'border-green text-green hover:bg-green hover:text-bg',
    warn: 'border-amber text-amber hover:bg-amber hover:text-bg',
    danger: 'border-red text-red hover:bg-red hover:text-bg',
  } as const;
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`border px-2 py-1 text-[11px] uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

/** Vote dot for the market strip / indicator panels. */
export function VoteDot({ vote }: { vote: string | null | undefined }) {
  const cls =
    vote === 'bull' ? 'bg-green' : vote === 'bear' ? 'bg-red' : vote === 'neutral' ? 'bg-line' : 'bg-transparent';
  return <span className={`inline-block h-1.5 w-1.5 ${cls}`} aria-hidden />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-muted">{children}</p>;
}
