'use client';

/**
 * lightweight-charts candles. Client-only: the library touches `document` at
 * import time, so it is `await import()`-ed inside the effect and this file
 * is only ever reached through a `next/dynamic` with `ssr: false`
 * (IMPL-4 Phase 6 pitfall 1).
 *
 * LIVE (IMPL-6 Part A). Pass `symbol`/`tf` and the chart subscribes to SSE
 * itself: forming bars (`closed:false`, ≤1/s per symbol×tf) move the last bar
 * in place via `series.update()`, `closed:true` finalises it, and `tick` events
 * carry the close in between (Binance's spot kline stream is only ~0.5/s).
 * `setData()` is called ONLY on the initial load, a symbol/tf switch, or a
 * detected hole in history — a React Query refetch merges into the live series,
 * so zoom/pan never resets.
 *
 * Callers must memoize `markers` / `priceLines` — they key the update effect.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  MouseEventParams,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { CHART_OPTIONS, CANDLE_COLORS, HEX } from '@/lib/chart-theme';

interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

function toBar(c: { ts: number; o: number; h: number; l: number; c: number }): Bar {
  return {
    time: Math.floor(c.ts / 1000) as UTCTimestamp,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
  };
}

/** Bar length per display timeframe — used to place a trade in its bar. */
const TF_MS: Record<string, number> = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

function sameBar(a: Bar, b: Bar): boolean {
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
}

export interface TradeMarker {
  ts: number;
  side: 'buy' | 'sell';
  reason: 'trade' | 'sl' | 'tp';
  /**
   * Someone else's fill (IMPL-4 /trade): drawn tiny and dim, never labelled —
   * "small, just informative". Hovering one shows `label` in the tooltip.
   */
  ghost?: boolean;
  /** Tooltip text — the bot name for ghosts. */
  label?: string;
}

export interface PriceLineSpec {
  price: number;
  title: string;
  tone: 'stop' | 'tp';
}

// Stable empty defaults: they key the marker/price-line effects, and a fresh
// `[]` per render would re-run them on every live tick.
const NO_MARKERS: TradeMarker[] = [];
const NO_LINES: PriceLineSpec[] = [];

export function CandleChart({
  candles,
  symbol,
  tf,
  markers = NO_MARKERS,
  priceLines = NO_LINES,
  height = 320,
  fill = false,
}: {
  candles: Candle[];
  /** Series identity — also switches on live SSE updates for this pair. */
  symbol?: string;
  tf?: string;
  markers?: TradeMarker[];
  priceLines?: PriceLineSpec[];
  height?: number;
  /** Fill the parent's height (parent must size itself, e.g. flex-1 min-h-0). */
  fill?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  /** What the series currently holds, keyed by bar time (seconds). */
  const barsRef = useRef(new Map<number, Bar>());
  const lastTimeRef = useRef<number | null>(null);
  /** `${symbol}:${tf}` the loaded series belongs to — null when unloaded. */
  const loadedKeyRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const seriesKey = `${symbol ?? ''}:${tf ?? ''}`;

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;

    void (async () => {
      const lc = await import('lightweight-charts');
      const box = boxRef.current;
      if (disposed || !box) return;
      const chart = lc.createChart(box, {
        ...CHART_OPTIONS,
        width: box.clientWidth,
        height: fill ? box.clientHeight : height,
      });
      chartRef.current = chart;
      seriesRef.current = chart.addCandlestickSeries(CANDLE_COLORS);
      observer = new ResizeObserver(() => {
        if (!boxRef.current) return;
        chart.applyOptions({
          width: boxRef.current.clientWidth,
          ...(fill ? { height: boxRef.current.clientHeight } : {}),
        });
      });
      observer.observe(box);
      setReady(true);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      linesRef.current = [];
      seriesRef.current = null;
      chartRef.current?.remove();
      chartRef.current = null;
      barsRef.current.clear();
      lastTimeRef.current = null;
      loadedKeyRef.current = null;
      setReady(false);
    };
  }, [height, fill]);

  // Query data → series. Full `setData` only when the series is empty, the
  // (symbol, tf) changed, or a hole in history turned up; otherwise the tail
  // is merged so the user's viewport is never touched.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!ready || !series || !chart) return;
    const incoming = candles.map(toBar);
    if (incoming.length === 0) return;

    const bars = barsRef.current;
    const switched = loadedKeyRef.current !== seriesKey;

    if (!switched && bars.size > 0) {
      const last = lastTimeRef.current ?? -Infinity;
      let hole = false;
      for (const bar of incoming) {
        const have = bars.get(bar.time);
        if (have && sameBar(have, bar)) continue;
        if (bar.time >= last) {
          series.update(bar);
          bars.set(bar.time, bar);
          lastTimeRef.current = bar.time;
        } else if (!have) {
          // A backfilled gap — only a rebuild can insert bars mid-series.
          hole = true;
        }
      }
      if (!hole) return;
      // Union, so the rebuild keeps both the older history already drawn and
      // the live forming bar the DB does not have yet.
      const merged = new Map(bars);
      for (const bar of incoming) merged.set(bar.time, bar);
      const data = [...merged.values()].sort((a, b) => a.time - b.time);
      const range = chart.timeScale().getVisibleLogicalRange();
      applyData(series, bars, lastTimeRef, data);
      if (range) chart.timeScale().setVisibleLogicalRange(range);
      return;
    }

    // Full load. A tf switch keeps the same time window (same market, same
    // context); a symbol switch (or first paint) resets the view.
    const sameSymbol = loadedKeyRef.current !== null && loadedKeyRef.current.split(':')[0] === symbol;
    const keepWindow = sameSymbol ? chart.timeScale().getVisibleRange() : null;
    applyData(series, bars, lastTimeRef, incoming);
    loadedKeyRef.current = seriesKey;
    restoreWindow(chart, incoming, keepWindow);
  }, [ready, candles, seriesKey, symbol]);

  // Trades. Binance's spot kline stream only pushes every ~2s, so the last
  // bar's close is carried by the (real-time) tick stream in between — that is
  // the same number the price chips show, so chart and chip never disagree.
  // Only the CURRENT bar is touched: rolling to a new period is the kline
  // stream's job, so Binance's official OHLCV always wins.
  useLive('tick', (e) => {
    const series = seriesRef.current;
    const step = tf ? TF_MS[tf] : undefined;
    const lastTime = lastTimeRef.current;
    if (!series || !symbol || !step || lastTime === null) return;
    if (e.symbol !== symbol || loadedKeyRef.current !== seriesKey) return;
    if (Math.floor(e.ts / step) * (step / 1000) !== lastTime) return;
    const prev = barsRef.current.get(lastTime);
    if (!prev || prev.close === e.price) return;
    const bar: Bar = {
      ...prev,
      high: Math.max(prev.high, e.price),
      low: Math.min(prev.low, e.price),
      close: e.price,
    };
    series.update(bar);
    barsRef.current.set(lastTime, bar);
  });

  // Live bars. Forming candles arrive ≤1/s per (symbol, tf) and update the
  // last bar in place; `closed:true` carries the final values for the same ts.
  useLive('candle', (e) => {
    const series = seriesRef.current;
    if (!series || !symbol || !tf) return;
    if (e.symbol !== symbol || e.tf !== tf) return;
    if (loadedKeyRef.current !== seriesKey) return; // history not loaded yet
    const bar = toBar(e);
    // Never move backwards: `update()` throws on an out-of-order time.
    if (lastTimeRef.current !== null && bar.time < lastTimeRef.current) return;
    series.update(bar);
    barsRef.current.set(bar.time, bar);
    lastTimeRef.current = bar.time;
  });

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!ready || !series || !chart) return;
    series.setMarkers(toMarkers(markers));

    // Marker tooltip: lightweight-charts reports the hovered marker's id on
    // the crosshair event, so no DOM overlay per marker is needed.
    const labels = new Map(markers.map((m, i) => [markerId(m, i), m.label ?? '']));
    const handler = (param: MouseEventParams<Time>): void => {
      const id = param.hoveredObjectId as string | undefined;
      const text = id === undefined ? undefined : labels.get(id);
      if (!text || !param.point) {
        setTip(null);
        return;
      }
      setTip({ x: param.point.x, y: param.point.y, text });
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [ready, markers]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!ready || !series) return;
    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = priceLines.map((l) =>
      series.createPriceLine({
        price: l.price,
        color: l.tone === 'stop' ? HEX.red : HEX.green,
        lineWidth: 1,
        lineStyle: 2, // LineStyle.Dashed — numeric so the enum stays lazy
        axisLabelVisible: true,
        title: l.title,
      }),
    );
  }, [ready, priceLines]);

  return (
    <div
      ref={boxRef}
      style={fill ? undefined : { height }}
      className={`relative w-full ${fill ? 'h-full min-h-[420px]' : ''}`}
    >
      {tip && (
        <div
          data-testid="chart-tooltip"
          className="pointer-events-none absolute z-10 whitespace-nowrap border border-line bg-panel px-1.5 py-0.5 text-[10px] text-fg"
          style={{ left: Math.max(0, tip.x - 20), top: Math.max(0, tip.y - 26) }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}

/** setData + the bookkeeping that keeps the merge path honest. */
function applyData(
  series: ISeriesApi<'Candlestick'>,
  bars: Map<number, Bar>,
  lastTime: { current: number | null },
  data: Bar[],
): void {
  series.setData(data);
  bars.clear();
  for (const b of data) bars.set(b.time, b);
  lastTime.current = data.length > 0 ? data[data.length - 1]!.time : null;
}

/**
 * Put the viewport back after an unavoidable reload: same time window when we
 * have one (tf switch), clamped to what the new series actually covers.
 */
function restoreWindow(chart: IChartApi, data: Bar[], keep: { from: Time; to: Time } | null): void {
  const scale = chart.timeScale();
  const from = Number(keep?.from);
  const to = Number(keep?.to);
  if (!keep || !Number.isFinite(from) || !Number.isFinite(to)) {
    scale.fitContent();
    return;
  }
  const clampedFrom = Math.max(from, data[0]!.time);
  const clampedTo = Math.min(to, data[data.length - 1]!.time);
  if (clampedTo - clampedFrom < 60) {
    scale.fitContent();
    return;
  }
  try {
    scale.setVisibleRange({ from: clampedFrom as UTCTimestamp, to: clampedTo as UTCTimestamp });
  } catch {
    scale.fitContent();
  }
}

function markerId(m: TradeMarker, i: number): string {
  return `${m.ghost ? 'g' : 'm'}${i}-${m.ts}`;
}

function toMarkers(markers: TradeMarker[]): Array<SeriesMarker<Time>> {
  return markers
    .map((m, i) => ({ m, id: markerId(m, i) }))
    .sort((a, b) => a.m.ts - b.m.ts)
    .map(({ m, id }) => ({
      id,
      time: Math.floor(m.ts / 1000) as UTCTimestamp,
      position: m.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
      shape: m.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
      // Ghosts: muted gray, undersized, no text — they must never compete with
      // your own trades. NOT `size: 0`: that hides the marker entirely
      // (lightweight-charts treats 0 as "invisible"), tooltip included.
      size: m.ghost ? 0.6 : 1,
      color: m.ghost
        ? HEX.muted
        : m.reason === 'sl'
          ? HEX.red
          : m.reason === 'tp'
            ? HEX.green
            : m.side === 'buy'
              ? HEX.green
              : HEX.amber,
      text: m.ghost ? '' : m.reason === 'trade' ? m.side.toUpperCase() : m.reason.toUpperCase(),
    }));
}
