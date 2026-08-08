'use client';

/**
 * lightweight-charts candles. Client-only: the library touches `document` at
 * import time, so it is `await import()`-ed inside the effect and this file
 * is only ever reached through a `next/dynamic` with `ssr: false`
 * (IMPL-4 Phase 6 pitfall 1).
 *
 * Callers must memoize `markers` / `priceLines` — they key the update effect.
 */

import { useEffect, useRef, useState } from 'react';
import type { IChartApi, IPriceLine, ISeriesApi, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '@/lib/api';
import { CHART_OPTIONS, CANDLE_COLORS, HEX } from '@/lib/chart-theme';

export interface TradeMarker {
  ts: number;
  side: 'buy' | 'sell';
  reason: 'trade' | 'sl' | 'tp';
}

export interface PriceLineSpec {
  price: number;
  title: string;
  tone: 'stop' | 'tp';
}

export function CandleChart({
  candles,
  markers = [],
  priceLines = [],
  height = 320,
}: {
  candles: Candle[];
  markers?: TradeMarker[];
  priceLines?: PriceLineSpec[];
  height?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;

    void (async () => {
      const lc = await import('lightweight-charts');
      const box = boxRef.current;
      if (disposed || !box) return;
      const chart = lc.createChart(box, { ...CHART_OPTIONS, width: box.clientWidth, height });
      chartRef.current = chart;
      seriesRef.current = chart.addCandlestickSeries(CANDLE_COLORS);
      observer = new ResizeObserver(() => {
        if (boxRef.current) chart.applyOptions({ width: boxRef.current.clientWidth });
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
      setReady(false);
    };
  }, [height]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!ready || !series || !chart) return;
    series.setData(
      candles.map((c) => ({
        time: Math.floor(c.ts / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );
    chart.timeScale().fitContent();
  }, [ready, candles]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!ready || !series) return;
    series.setMarkers(toMarkers(markers));
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

  return <div ref={boxRef} style={{ height }} className="w-full" />;
}

function toMarkers(markers: TradeMarker[]): Array<SeriesMarker<Time>> {
  return [...markers]
    .sort((a, b) => a.ts - b.ts)
    .map((m) => ({
      time: Math.floor(m.ts / 1000) as UTCTimestamp,
      position: m.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
      shape: m.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
      color:
        m.reason === 'sl'
          ? HEX.red
          : m.reason === 'tp'
            ? HEX.green
            : m.side === 'buy'
              ? HEX.green
              : HEX.amber,
      text: m.reason === 'trade' ? m.side.toUpperCase() : m.reason.toUpperCase(),
    }));
}
