'use client';

import { useEffect } from 'react';
import type { NewsEventLike } from './NewsCard';

interface NewsDrawerProps {
  event: NewsEventLike | null;
  onClose: () => void;
}

function formatTimestamp(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function sentimentLabel(sent: number | null | undefined): string {
  if (sent === null || sent === undefined || !Number.isFinite(sent))
    return 'NEUTRAL';
  const sign = sent > 0 ? '+' : '';
  return `${sign}${sent.toFixed(3)}`;
}

function sentimentClass(sent: number | null | undefined): string {
  if (sent === null || sent === undefined || !Number.isFinite(sent)) {
    return 'text-text-dim';
  }
  if (sent > 0) return 'text-neon-green';
  if (sent < 0) return 'text-neon-red';
  return 'text-text-dim';
}

export function NewsDrawer({ event, onClose }: NewsDrawerProps) {
  useEffect(() => {
    if (!event) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [event, onClose]);

  if (!event) return null;

  return (
    <>
      <div className="fixed inset-0 bg-bg-void/70 z-40" onClick={onClose} />
      <aside
        className="fixed top-0 right-0 h-full w-[32rem] max-w-[95vw] bg-bg-terminal border-l-2 border-neon-amber z-50 flex flex-col shadow-[0_0_16px_var(--neon-amber)]"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border-dim shrink-0">
          <h2 className="pixel-font text-[10px] text-neon-amber glow uppercase">
            News Detail
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="pixel-font text-[9px] px-2 py-1 border-2 border-border-dim text-text-secondary hover:border-neon-red hover:text-neon-red"
          >
            CLOSE
          </button>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-4 p-3">
          {/* Source + time */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="pixel-font text-[8px] px-2 py-1 border-2 border-neon-cyan text-neon-cyan uppercase">
              {event.source}
            </span>
            <span className="vt-font text-[13px] text-text-secondary">
              {formatTimestamp(event.ts)}
            </span>
          </div>

          {/* Title */}
          <h3 className="vt-font text-[22px] text-text-primary leading-tight">
            {event.title}
          </h3>

          {/* Summary */}
          {event.summary ? (
            <p className="vt-font text-[15px] text-text-secondary leading-relaxed">
              {event.summary}
            </p>
          ) : null}

          {/* Sentiment */}
          <div className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Sentiment
            </span>
            <span
              className={`vt-font text-[20px] ${sentimentClass(event.sentiment)}`}
            >
              {sentimentLabel(event.sentiment)}
            </span>
          </div>

          {/* Tickers */}
          {event.tickers && event.tickers.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="pixel-font text-[8px] text-text-secondary uppercase">
                Tickers
              </span>
              <div className="flex flex-wrap gap-1">
                {event.tickers.map((t) => (
                  <span
                    key={t}
                    className="pixel-font text-[9px] px-2 py-1 border-2 border-neon-magenta text-neon-magenta"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {/* Link-out */}
          <div className="mt-2">
            <a
              href={event.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pixel-font text-[9px] inline-block px-3 py-2 border-2 border-neon-amber text-neon-amber hover:bg-neon-amber hover:text-bg-void transition-colors"
            >
              OPEN ARTICLE →
            </a>
          </div>
        </div>
      </aside>
    </>
  );
}

export default NewsDrawer;
