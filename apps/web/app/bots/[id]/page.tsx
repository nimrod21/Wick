'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, TIMEFRAMES, type Tf } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Btn, Empty, Panel, Stat } from '@/components/ui';
import { BotControls } from '@/components/bot/BotControls';
import { DecisionLog } from '@/components/bot/DecisionLog';
import { IndicatorStats } from '@/components/bot/IndicatorStats';
import { JournalTab } from '@/components/bot/JournalTab';
import { TriggerTab } from '@/components/bot/TriggerTab';
import type { PriceLineSpec, TradeMarker } from '@/components/charts/CandleChart';
import { pct, price, shortSymbol, usd } from '@/lib/format';

// lightweight-charts is client-only (IMPL-4 Phase 6 pitfall 1).
const CandleChart = dynamic(() => import('@/components/charts/CandleChart').then((m) => m.CandleChart), {
  ssr: false,
  loading: () => <div className="h-[320px] animate-none" />,
});
const EquityChart = dynamic(() => import('@/components/charts/EquityChart').then((m) => m.EquityChart), {
  ssr: false,
  loading: () => <div className="h-[200px]" />,
});

type Tab = 'decisions' | 'indicators' | 'journal' | 'triggers';
const TABS: Tab[] = ['decisions', 'indicators', 'journal', 'triggers'];

export default function BotPage() {
  const params = useParams<{ id: string }>();
  const botId = Number(params.id);
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('decisions');
  const [symbol, setSymbol] = useState<string | null>(null);
  const [tf, setTf] = useState<Tf>('1h');

  const bot = useQuery({ queryKey: ['bot', botId], queryFn: () => api.bot(botId), enabled: Number.isFinite(botId) });
  const equity = useQuery({ queryKey: ['bot-equity', botId], queryFn: () => api.equity(botId, 500), enabled: !!bot.data });
  const positions = useQuery({ queryKey: ['bot-positions', botId], queryFn: () => api.positions(botId), enabled: !!bot.data });
  const fills = useQuery({ queryKey: ['bot-fills', botId], queryFn: () => api.fills(botId, 500), enabled: !!bot.data });
  const decisions = useQuery({ queryKey: ['bot-outcomes', botId], queryFn: () => api.outcomes(botId, 500), enabled: !!bot.data });
  const stats = useQuery({ queryKey: ['bot-stats', botId], queryFn: () => api.stats(botId), enabled: !!bot.data });
  const journal = useQuery({ queryKey: ['bot-journal', botId], queryFn: () => api.journal(botId), enabled: !!bot.data });
  const triggers = useQuery({ queryKey: ['bot-triggers', botId], queryFn: () => api.triggers(botId), enabled: !!bot.data });

  const activeSymbol = symbol ?? bot.data?.config.symbols[0] ?? 'BTCUSDT';
  const candles = useQuery({
    queryKey: ['candles', activeSymbol, tf],
    queryFn: () => api.candles(activeSymbol, tf, 300),
    enabled: !!bot.data,
  });

  // Live: anything touching this bot refreshes the relevant slice.
  useLive('decision', (e) => {
    if (e.botId === botId) void qc.invalidateQueries({ queryKey: ['bot-outcomes', botId] });
  });
  useLive('fill', (e) => {
    if (e.botId !== botId) return;
    void qc.invalidateQueries({ queryKey: ['bot-fills', botId] });
    void qc.invalidateQueries({ queryKey: ['bot-positions', botId] });
    void qc.invalidateQueries({ queryKey: ['bot-equity', botId] });
  });
  useLive('bot_status', (e) => {
    if (e.botId === botId) void qc.invalidateQueries({ queryKey: ['bot', botId] });
  });
  useLive('outcome', (e) => {
    if (e.botId === botId) void qc.invalidateQueries({ queryKey: ['bot-outcomes', botId] });
  });
  useLive('trigger', (e) => {
    if (e.botId === botId) void qc.invalidateQueries({ queryKey: ['bot-triggers', botId] });
  });

  /** Highest-weight indicators first — the ones actually swaying this bot. */
  const trusted = useMemo(
    () =>
      [...(stats.data ?? [])]
        .sort((a, b) => b.weight - a.weight || b.samples - a.samples)
        .slice(0, 8),
    [stats.data],
  );

  /** Protector exits are `trigger_type = 'protector'` with `sl:`/`tp:` detail. */
  const exitReasons = useMemo(() => {
    const map = new Map<number, 'sl' | 'tp'>();
    for (const d of decisions.data ?? []) {
      if (d.triggerType !== 'protector') continue;
      const detail = d.triggerDetail ?? '';
      if (detail.startsWith('sl')) map.set(d.id, 'sl');
      else if (detail.startsWith('tp')) map.set(d.id, 'tp');
    }
    return map;
  }, [decisions.data]);

  const markers: TradeMarker[] = useMemo(
    () =>
      (fills.data ?? [])
        .filter((f) => f.symbol === activeSymbol)
        .map((f) => ({
          ts: f.ts,
          side: f.side,
          reason: (f.decision_id !== null ? exitReasons.get(f.decision_id) : undefined) ?? 'trade',
        })),
    [fills.data, activeSymbol, exitReasons],
  );

  const priceLines: PriceLineSpec[] = useMemo(() => {
    const p = (positions.data ?? []).find((x) => x.symbol === activeSymbol);
    if (!p) return [];
    const out: PriceLineSpec[] = [];
    if (p.stopPrice !== null) out.push({ price: p.stopPrice, title: 'SL', tone: 'stop' });
    if (p.tpPrice !== null) out.push({ price: p.tpPrice, title: 'TP', tone: 'tp' });
    return out;
  }, [positions.data, activeSymbol]);

  if (bot.isLoading) return <Empty>loading bot…</Empty>;
  if (bot.isError || !bot.data) return <Empty>bot not found</Empty>;

  const b = bot.data;
  const symbols = b.config.symbols;
  const pnlPct = b.bankrollStart > 0 ? ((b.equity - b.bankrollStart) / b.bankrollStart) * 100 : null;

  return (
    <div className="space-y-4">
      <BotControls bot={b} />

      {/* What this bot currently believes in — the learning loop made visible. */}
      <Panel
        title="Trusted indicators"
        right={
          <span className="text-[10px] uppercase tracking-wider text-muted">
            {trusted.length > 0 ? `top ${trusted.length} of ${stats.data?.length ?? 0} by weight` : 'weights start at 1.00'}
          </span>
        }
        bodyClassName="p-0"
      >
        <IndicatorStats stats={trusted} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Panel title="Equity" bodyClassName="p-0">
          <div className="grid grid-cols-3 gap-2 border-b border-line p-3">
            <Stat label="equity" value={usd(b.equity)} />
            <Stat label="cash" value={usd(b.cash)} />
            <Stat
              label="P&L"
              value={pct(pnlPct)}
              valueClass={pnlPct === null || pnlPct === 0 ? 'text-muted' : pnlPct > 0 ? 'text-green' : 'text-red'}
            />
            <Stat label="high-water" value={usd(equity.data?.highWaterMark ?? null)} />
            <Stat
              label="drawdown"
              value={pct(equity.data?.drawdownPct === undefined ? null : -(equity.data.drawdownPct ?? 0))}
              valueClass={(equity.data?.drawdownPct ?? 0) > 0 ? 'text-red' : 'text-muted'}
            />
            <Stat label="kill at" value={`-${b.config.drawdown_kill_pct}%`} />
          </div>
          {(equity.data?.snapshots.length ?? 0) < 2 ? (
            <Empty>equity snapshots build hourly — nothing to plot yet</Empty>
          ) : (
            <EquityChart snapshots={equity.data!.snapshots} />
          )}
        </Panel>

        <Panel
          title="Price"
          right={
            <div className="flex flex-wrap items-center gap-1">
              {symbols.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSymbol(s)}
                  className={`px-1 text-[10px] uppercase ${s === activeSymbol ? 'text-cyan' : 'text-muted hover:text-fg'}`}
                >
                  {shortSymbol(s)}
                </button>
              ))}
              <span className="mx-1 text-line">|</span>
              {TIMEFRAMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTf(t)}
                  className={`px-1 text-[10px] ${t === tf ? 'text-cyan' : 'text-muted hover:text-fg'}`}
                >
                  {t}
                </button>
              ))}
            </div>
          }
          bodyClassName="p-0"
        >
          {(candles.data?.length ?? 0) === 0 ? (
            <Empty>no candles for {activeSymbol} {tf}</Empty>
          ) : (
            <CandleChart candles={candles.data!} markers={markers} priceLines={priceLines} />
          )}
          <div className="flex flex-wrap gap-3 border-t border-line p-2 text-xs">
            {(positions.data ?? []).length === 0 ? (
              <span className="text-muted">flat</span>
            ) : (
              (positions.data ?? []).map((p) => (
                <span key={p.symbol} className="tnum">
                  <span className="text-muted">{shortSymbol(p.symbol)}</span> {p.qty.toFixed(4)} @{' '}
                  {price(p.avgEntry)} ·{' '}
                  <span className={(p.unrealizedPnl ?? 0) >= 0 ? 'text-green' : 'text-red'}>
                    {usd(p.unrealizedPnl)}
                  </span>
                </span>
              ))
            )}
          </div>
        </Panel>
      </div>

      <Panel
        title={
          <span className="flex gap-3">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`uppercase tracking-wider ${t === tab ? 'text-cyan' : 'text-muted hover:text-fg'}`}
              >
                {t}
              </button>
            ))}
          </span>
        }
        right={
          tab === 'decisions' ? (
            <Btn onClick={() => void qc.invalidateQueries({ queryKey: ['bot-outcomes', botId] })}>refresh</Btn>
          ) : undefined
        }
        bodyClassName="p-0"
      >
        {tab === 'decisions' && <DecisionLog decisions={decisions.data ?? []} />}
        {tab === 'indicators' && <IndicatorStats stats={stats.data ?? []} />}
        {tab === 'journal' && (
          <JournalTab entries={journal.data?.entries ?? []} lessons={journal.data?.lessons ?? null} />
        )}
        {tab === 'triggers' && <TriggerTab triggers={triggers.data ?? []} />}
      </Panel>
    </div>
  );
}
