'use client';

/**
 * One bot, one card. The **frame colour is the status** (LAYOUT.md): lit green
 * running · dim gray stopped · red busted — readable without reading a word.
 *
 * `actions` turns on the fleet-management row (/bots page); the dashboard grid
 * renders the same card read-only. The whole card links to the detail page via
 * a stretched overlay link, so the action buttons can sit inside it without
 * nesting interactive elements.
 *
 * `small` is the dashboard bot-strip variant (IMPL-5): frame status, name,
 * equity, spark and the next wake — nothing else, and no per-bot
 * outcome/position fetches, so a strip of N bots costs N queries, not 3N.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Bot } from '@/lib/api';
import { Btn, PixelTitle, Sparkline, Stat, StatusLed } from '@/components/ui';
import { pct, shortSymbol, until, usd } from '@/lib/format';

const DAY_MS = 24 * 3_600_000;

const FRAME: Record<Bot['status'], string> = {
  running: 'frame-running',
  stopped: 'frame-stopped',
  busted: 'frame-busted',
};

/** "next wake in 12m" — "—" for anything not on a cadence (stopped/busted). */
function NextWake({ bot, className = '' }: { bot: Bot; className?: string }) {
  return (
    <span
      className={`tnum text-[10px] text-muted ${className}`}
      title={
        bot.nextWakeTs === null
          ? 'not running — no scheduled wake'
          : `next ${bot.config.cadence_tf} cadence wake at ${new Date(bot.nextWakeTs).toLocaleTimeString([], { hour12: false })}`
      }
    >
      next wake {bot.nextWakeTs === null ? '—' : `in ${until(bot.nextWakeTs)}`}
    </span>
  );
}

export function BotCard({
  bot,
  actions = false,
  small = false,
}: {
  bot: Bot;
  actions?: boolean;
  small?: boolean;
}) {
  const { data: equity } = useQuery({
    queryKey: ['bot-equity', bot.id],
    queryFn: () => api.equity(bot.id, 200),
    refetchInterval: 60_000,
  });
  const { data: decisions } = useQuery({
    queryKey: ['bot-outcomes', bot.id, 'card'],
    queryFn: () => api.outcomes(bot.id, 300),
    refetchInterval: 60_000,
    enabled: !small,
  });
  const { data: positions } = useQuery({
    queryKey: ['bot-positions', bot.id],
    queryFn: () => api.positions(bot.id),
    refetchInterval: 30_000,
    enabled: !small,
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

  if (small) {
    return (
      <Link
        href={`/bots/${bot.id}`}
        className={`panel flex min-w-[190px] items-center gap-3 p-2 hover:border-cyan ${FRAME[bot.status]}`}
      >
        <StatusLed status={bot.status} />
        <span className="min-w-0 flex-1">
          <PixelTitle as="span" className="block truncate text-fg">
            {bot.name}
          </PixelTitle>
          <span className="mt-1 flex items-baseline gap-2">
            <span className="tnum text-sm">{usd(bot.equity, 0)}</span>
            <span
              className={`tnum text-[10px] ${pnlPct === null || pnlPct === 0 ? 'text-muted' : pnlPct > 0 ? 'text-green' : 'text-red'}`}
            >
              {pct(pnlPct, 1)}
            </span>
          </span>
          <NextWake bot={bot} className="mt-0.5 block" />
        </span>
        <Sparkline values={spark} width={56} height={24} />
      </Link>
    );
  }

  return (
    <article className={`panel relative p-3 ${FRAME[bot.status]}`}>
      <Link href={`/bots/${bot.id}`} className="absolute inset-0 z-10" aria-label={`open ${bot.name}`} />

      <div className="flex items-center justify-between gap-2">
        <PixelTitle as="span" className="text-fg">
          {bot.name}
        </PixelTitle>
        <span className="flex items-center gap-2">
          <NextWake bot={bot} />
          <StatusLed status={bot.status} label />
        </span>
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

      {actions && <CardActions bot={bot} />}
    </article>
  );
}

/** start / stop / add funds / delete — the whole point of the /bots page. */
function CardActions({ bot }: { bot: Bot }) {
  const qc = useQueryClient();
  const [funds, setFunds] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['bots'] });
    void qc.invalidateQueries({ queryKey: ['bot', bot.id] });
    void qc.invalidateQueries({ queryKey: ['bot-equity', bot.id] });
  };

  const action = useMutation({
    mutationFn: (a: 'start' | 'stop') => api.botAction(bot.id, a),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message),
  });

  const topUp = useMutation({
    mutationFn: (amount: number) => api.patchBot(bot.id, { add_funds: amount }),
    onSuccess: () => {
      setFunds(null);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteBot(bot.id),
    onSuccess: () => {
      // Drop this bot's queries before the list refetch unmounts the card —
      // invalidating them instead would refetch equity/positions for a bot that
      // no longer exists (404s in the console).
      qc.removeQueries({ predicate: (q) => q.queryKey[1] === bot.id });
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const busy = action.isPending || topUp.isPending || remove.isPending;

  const submitFunds = (): void => {
    const n = Number(funds);
    if (!Number.isFinite(n) || n <= 0) {
      setError('amount must be a positive number');
      return;
    }
    setError(null);
    topUp.mutate(n);
  };

  return (
    <div className="relative z-20 mt-3 border-t border-line pt-2">
      <div className="flex flex-wrap items-center gap-1">
        <Btn
          tone="go"
          onClick={() => action.mutate('start')}
          disabled={busy || bot.status === 'running' || bot.status === 'busted'}
          title={bot.status === 'busted' ? 'a busted bot must be reset first' : undefined}
        >
          start
        </Btn>
        <Btn tone="warn" onClick={() => action.mutate('stop')} disabled={busy || bot.status === 'stopped'}>
          stop
        </Btn>
        <Btn onClick={() => { setError(null); setFunds(funds === null ? '100' : null); }} disabled={busy}>
          add funds
        </Btn>
        <Btn
          tone="danger"
          onClick={() => {
            if (
              window.confirm(
                `Delete ${bot.name}? This removes the bot and ALL of its history — decisions, fills, positions, equity, journal and indicator stats. Cannot be undone.`,
              )
            ) {
              setError(null);
              remove.mutate();
            }
          }}
          disabled={busy || bot.status === 'running'}
          title={bot.status === 'running' ? 'stop the bot before deleting it' : undefined}
        >
          delete
        </Btn>
      </div>

      {funds !== null && (
        <div className="mt-2 flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted">add $</span>
          <input
            type="number"
            min="1"
            step="10"
            className="w-24 py-0.5 text-xs"
            value={funds}
            autoFocus
            onChange={(e) => setFunds(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitFunds()}
          />
          <Btn tone="go" onClick={submitFunds} disabled={topUp.isPending}>
            apply
          </Btn>
          <Btn onClick={() => setFunds(null)}>cancel</Btn>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red">{error}</p>}
    </div>
  );
}
