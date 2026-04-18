'use client';

export interface NewsEventLike {
  id: number;
  ts: number;
  source: string;
  title: string;
  url: string;
  summary?: string | null;
  tickers?: string[];
  sentiment?: number | null;
  category?: string;
}

interface NewsCardProps {
  event: NewsEventLike;
  onOpen: (event: NewsEventLike) => void;
  now: number;
}

function relativeTime(tsSec: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - tsSec));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86_400)}d`;
}

function sentimentLabel(sent: number | null | undefined): string {
  if (sent === null || sent === undefined || !Number.isFinite(sent)) return '–';
  const sign = sent > 0 ? '+' : '';
  return `${sign}${sent.toFixed(2)}`;
}

function sentimentClass(sent: number | null | undefined): string {
  if (sent === null || sent === undefined || !Number.isFinite(sent)) {
    return 'text-text-dim border-border-dim';
  }
  if (sent > 0) return 'text-neon-green border-neon-green';
  if (sent < 0) return 'text-neon-red border-neon-red';
  return 'text-text-dim border-border-dim';
}

export function NewsCard({ event, onOpen, now }: NewsCardProps) {
  const sentChip = sentimentClass(event.sentiment);
  const rel = relativeTime(event.ts, now);
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      className="w-full text-left flex flex-col gap-2 border border-border-dim bg-bg-terminal p-3 hover:border-neon-amber hover:bg-bg-elevated transition-colors"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="pixel-font text-[8px] px-2 py-1 border-2 border-neon-cyan text-neon-cyan uppercase">
          {event.source}
        </span>
        <span className="vt-font text-[12px] text-text-dim">{rel} ago</span>
        <span
          className={`pixel-font text-[8px] px-2 py-1 border-2 ${sentChip}`}
        >
          {sentimentLabel(event.sentiment)}
        </span>
      </div>
      <h3 className="vt-font text-[18px] text-text-primary leading-tight">
        {event.title}
      </h3>
      {event.tickers && event.tickers.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {event.tickers.slice(0, 8).map((t) => (
            <span
              key={t}
              className="pixel-font text-[8px] px-2 py-1 border-2 border-neon-magenta text-neon-magenta"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

export default NewsCard;
