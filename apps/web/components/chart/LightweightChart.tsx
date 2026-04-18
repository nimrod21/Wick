'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type CandlestickData,
  type HistogramData,
} from 'lightweight-charts';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';
import type { Timeframe } from '@/lib/store';

interface LightweightChartProps {
  assetId: number;
  timeframe: Timeframe;
  height?: number;
}

interface RawCandle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CandlesResponse {
  candles: RawCandle[];
}

interface CandleEvent {
  kind: 'candle';
  assetId: number;
  timeframe: Timeframe;
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface TradeTickEvent {
  kind: 'trade_tick';
  assetId: number;
  ts: number;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
}

type StreamEvent = CandleEvent | TradeTickEvent | { kind: string; [k: string]: unknown };

function toCandle(r: RawCandle): CandlestickData<UTCTimestamp> {
  return {
    time: r.ts as UTCTimestamp,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
  };
}

function toVolume(r: RawCandle): HistogramData<UTCTimestamp> {
  return {
    time: r.ts as UTCTimestamp,
    value: r.v,
    color: r.c >= r.o ? '#39ff14' : '#ff3864',
  };
}

export function LightweightChart({ assetId, timeframe, height = 400 }: LightweightChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastCandleRef = useRef<RawCandle | null>(null);

  const { data, isLoading, error } = useQuery<CandlesResponse>({
    queryKey: ['candles', assetId, timeframe],
    queryFn: () =>
      api.get<CandlesResponse>(
        `/api/candles?assetId=${assetId}&timeframe=${timeframe}&limit=500`,
      ),
  });

  const { lastEvent } = useEventStream(['candle', 'trade_tick'], { assetIds: [assetId] });

  // ---------- Create chart on mount ----------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#e0e0ff',
        fontFamily: '"VT323", monospace',
        fontSize: 14,
      },
      grid: {
        vertLines: { color: '#1a2040' },
        horzLines: { color: '#1a2040' },
      },
      rightPriceScale: { borderColor: '#3a4060' },
      timeScale: { borderColor: '#3a4060', timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: '#00ffff', labelBackgroundColor: '#0a0014' },
        horzLine: { color: '#00ffff', labelBackgroundColor: '#0a0014' },
      },
      width: container.clientWidth,
      height,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#39ff14',
      downColor: '#ff3864',
      wickUpColor: '#39ff14',
      wickDownColor: '#ff3864',
      borderVisible: false,
    });

    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      color: '#55557a',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        chart.applyOptions({ width });
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      lastCandleRef.current = null;
    };
  }, [height]);

  // ---------- Populate initial candles when data loads / timeframe changes ----------
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart || !data?.candles) return;

    const candles = data.candles;
    candleSeries.setData(candles.map(toCandle));
    volumeSeries.setData(candles.map(toVolume));
    lastCandleRef.current = candles.length > 0 ? { ...candles[candles.length - 1] } : null;
    chart.timeScale().fitContent();
  }, [data]);

  // ---------- Apply streamed events ----------
  useEffect(() => {
    if (!lastEvent) return;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries) return;

    const ev = lastEvent as StreamEvent;

    if (ev.kind === 'candle') {
      const c = ev as CandleEvent;
      if (c.assetId !== assetId) return;
      if (c.timeframe !== timeframe) return;
      const raw: RawCandle = { ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      candleSeries.update(toCandle(raw));
      volumeSeries.update(toVolume(raw));
      lastCandleRef.current = raw;
      return;
    }

    if (ev.kind === 'trade_tick' && timeframe === '1m') {
      const t = ev as TradeTickEvent;
      if (t.assetId !== assetId) return;
      const last = lastCandleRef.current;
      if (!last) return;
      const updated: RawCandle = {
        ts: last.ts,
        o: last.o,
        h: Math.max(last.h, t.price),
        l: Math.min(last.l, t.price),
        c: t.price,
        v: last.v + t.qty,
      };
      candleSeries.update(toCandle(updated));
      volumeSeries.update(toVolume(updated));
      lastCandleRef.current = updated;
    }
  }, [lastEvent, assetId, timeframe]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0" />
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="vt-font text-neon-cyan glow text-lg">LOADING CANDLES...</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="vt-font text-neon-red glow text-lg">
            CHART ERROR: {error instanceof Error ? error.message : 'unknown'}
          </span>
        </div>
      )}
    </div>
  );
}
