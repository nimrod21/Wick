'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api, type Bot } from '@/lib/api';
import { PixelTitle, Sparkline, Stat, StatusLed } from '@/components/ui';
import { pct, shortSymbol, usd } from '@/lib/format';

const DAY_MS = 24 * 3_600_000;

export function BotCard({ bot }: { bot: Bot }) {
  const { data: equity } = useQuery({
    queryKey: ['bot-equity', bot.id],
    queryFn: () => api.equity(bot.id, 200),
    refetchInterval: 60_000,
  });
  const { data: decisions } = useQuery({
    queryKey: ['bot-outcomes', bot.id, 'card'],
    queryFn: () => api.outcomes(bot.id, 300),
    refetchInterval: 60_000,
  });
  const { data: positions } = useQuery({
    queryKey: ['bot-positions', bot.id],
    queryFn: () => api.positions(bot.id),
    refetchInterval: 30_000,
  });

  const since = Date.now() - DAY_MS;
  const spark = (equity?.snapshots ?? []).filter((s) => s.ts >= since).map((s) => s.equity);

  // W/L from the PRIMARY 4h horizon (PLAN §11).
  let wins = 0;
  let losses = 0;
  let tradesToday = 0;
  let callsToday = 0;
  const midnight = new Date().setUTCHours(0, 0, 0, 0);
  for (const d of decisions ?? []) {
    const o = d.outcomes['4h'];
    if (o && o.score !== null) {
      if (o.score > 0) wins += 1;
      else if (o.score < 0) losses += 1;
    }
    if (d.ts >= midnight) {
      if (d.provider !== null && d.provider !== 'code') callsToday += 1;
      if (d.status === 'executed' && (d.action === 'buy' || d.action === 'sell')) tradesToday += 1;
    }
  }

  const pnlPct = bot.bankrollStart > 0 ? ((bot.equity - bot.bankrollStart) / bot.bankrollStart) * 100 : null;

  return (
    <Link
      href={`/bots/${bot.id}`}
      className="panel block p-3 transition-colors hover:border-cyan"
    >
      <div className="flex items-center justify-between gap-2">
        <PixelTitle as="span" className="text-fg">
          {bot.name}
        </PixelTitle>
        <StatusLed status={bot.status} label />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <div className="tnum text-lg">{usd(bot.equity)}</div>
          <div className={`tnum text-xs ${pnlPct === null || pnlPct === 0 ? 'text-muted' : pnlPct > 0 ? 'text-green' : 'text-red'}`}>
            {pct(pnlPct)} vs {usd(bot.bankrollStart, 0)}
          </div>
        </div>
        <Sparkline values={spark} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2">
        <Stat label="W / L (4h)" value={`${wins} / ${losses}`} />
        <Stat label="Trades today" value={`${tradesToday} / ${bot.config.max_trades_day}`} />
        <Stat label="Calls today" value={callsToday} />
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {(positions ?? []).length === 0 ? (
          <span className="text-[10px] uppercase tracking-wider text-muted">flat</span>
        ) : (
          (positions ?? []).map((p) => (
            <span
              key={p.symbol}
              className={`tnum border px-1 text-[10px] ${
                p.unrealizedPnl === null || p.unrealizedPnl === 0
                  ? 'border-line text-muted'
                  : p.unrealizedPnl > 0
                    ? 'border-green text-green'
                    : 'border-red text-red'
              }`}
            >
              {shortSymbol(p.symbol)} {usd(p.valueUsd, 0)}
            </span>
          ))
        )}
      </div>
    </Link>
  );
}
