'use client';

import { useEffect, useRef, useState } from 'react';
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
import { ChartOverlays } from './ChartOverlays';

interface LightweightChartProps {
  assetId: number;
  timeframe: Timeframe;
  /** Optional fixed height. If omitted, chart fills its parent (which must have measured height). */
  height?: number;
  /** Optional symbol (e.g. "BTCUSDT") used to fetch TA overlays. Overlays no-op when absent. */
  symbol?: string;
}

interface IndicatorPoint {
  ts: number;
  value: number;
}

interface IndicatorHistoryResponse {
  points: IndicatorPoint[];
}

interface IndicatorEvent {
  kind: 'indicator';
  name: string;
  value: number;
  ts: number;
  source?: string;
  id?: number;
}

const EMA_COLORS = { ema20: '#00ffff', ema50: '#ff5af7', ema200: '#ffb347' } as const;
const RSI_COLOR = '#b967ff';
const MACD_LINE_COLOR = '#00ffff';
const MACD_SIGNAL_COLOR = '#ffb347';
const MACD_HIST_UP_COLOR = '#39ff14';
const MACD_HIST_DOWN_COLOR = '#ff3864';

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

export function LightweightChart({ assetId, timeframe, height, symbol }: LightweightChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastCandleRef = useRef<RawCandle | null>(null);
  const fitToParent = height === undefined;

  // TA overlay toggles and their series refs.
  const [overlays, setOverlays] = useState<{ ema: boolean; rsi: boolean; macd: boolean }>({
    ema: false,
    rsi: false,
    macd: false,
  });
  const emaSeriesRef = useRef<{
    ema20?: ISeriesApi<'Line'>;
    ema50?: ISeriesApi<'Line'>;
    ema200?: ISeriesApi<'Line'>;
  }>({});
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdLineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdHistRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const { data, isLoading, error } = useQuery<CandlesResponse>({
    queryKey: ['candles', assetId, timeframe],
    queryFn: () =>
      api.get<CandlesResponse>(
        `/api/candles?assetId=${assetId}&timeframe=${timeframe}&limit=500`,
      ),
  });

  const { lastEvent } = useEventStream(['candle', 'trade_tick'], { assetIds: [assetId] });
  // Indicator events don't carry assetId; filter by name prefix in the effect below.
  const { lastEvent: lastIndicatorEvent } = useEventStream(['indicator']);

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
        attributionLogo: false,
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
      height: height ?? container.clientHeight,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#39ff14',
      downColor: '#ff3864',
      wickUpColor: '#39ff14',
      wickDownColor: '#ff3864',
      borderVisible: false,
    });

    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      color: '#55557a',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
      visible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = fitToParent ? entry.contentRect.height : height;
        chart.applyOptions({ width: w, height: h });
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

    if (ev.kind === 'trade_tick') {
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

  // ---------- EMA overlay ----------
  useEffect(() => {
    const chart = chartRef.current;
    const refs = emaSeriesRef.current;

    if (!overlays.ema || !chart || !symbol) {
      // Tear down existing EMA series if any.
      if (refs.ema20 && chart) chart.removeSeries(refs.ema20);
      if (refs.ema50 && chart) chart.removeSeries(refs.ema50);
      if (refs.ema200 && chart) chart.removeSeries(refs.ema200);
      emaSeriesRef.current = {};
      return;
    }

    const ema20 = chart.addLineSeries({
      color: EMA_COLORS.ema20,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const ema50 = chart.addLineSeries({
      color: EMA_COLORS.ema50,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const ema200 = chart.addLineSeries({
      color: EMA_COLORS.ema200,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    emaSeriesRef.current = { ema20, ema50, ema200 };

    let cancelled = false;
    const load = async () => {
      try {
        const [r20, r50, r200] = await Promise.all([
          api.get<IndicatorHistoryResponse>(
            `/api/indicators/history?name=ema20_${encodeURIComponent(symbol)}&limit=500`,
          ),
          api.get<IndicatorHistoryResponse>(
            `/api/indicators/history?name=ema50_${encodeURIComponent(symbol)}&limit=500`,
          ),
          api.get<IndicatorHistoryResponse>(
            `/api/indicators/history?name=ema200_${encodeURIComponent(symbol)}&limit=500`,
          ),
        ]);
        if (cancelled) return;
        ema20.setData(r20.points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value })));
        ema50.setData(r50.points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value })));
        ema200.setData(r200.points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value })));
      } catch {
        /* swallow; overlay just stays empty */
      }
    };
    load();

    return () => {
      cancelled = true;
      const current = emaSeriesRef.current;
      if (chartRef.current) {
        if (current.ema20) chartRef.current.removeSeries(current.ema20);
        if (current.ema50) chartRef.current.removeSeries(current.ema50);
        if (current.ema200) chartRef.current.removeSeries(current.ema200);
      }
      emaSeriesRef.current = {};
    };
  }, [overlays.ema, symbol]);

  // ---------- RSI overlay ----------
  useEffect(() => {
    const chart = chartRef.current;

    if (!overlays.rsi || !chart || !symbol) {
      if (rsiSeriesRef.current && chart) chart.removeSeries(rsiSeriesRef.current);
      rsiSeriesRef.current = null;
      return;
    }

    const rsi = chart.addLineSeries({
      color: RSI_COLOR,
      lineWidth: 1,
      priceScaleId: 'rsi',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('rsi').applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
      visible: false,
    });
    rsiSeriesRef.current = rsi;

    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<IndicatorHistoryResponse>(
          `/api/indicators/history?name=rsi14_${encodeURIComponent(symbol)}&limit=500`,
        );
        if (cancelled) return;
        rsi.setData(res.points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value })));
      } catch {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
      if (chartRef.current && rsiSeriesRef.current) {
        chartRef.current.removeSeries(rsiSeriesRef.current);
      }
      rsiSeriesRef.current = null;
    };
  }, [overlays.rsi, symbol]);

  // ---------- MACD overlay ----------
  useEffect(() => {
    const chart = chartRef.current;

    if (!overlays.macd || !chart || !symbol) {
      if (macdLineRef.current && chart) chart.removeSeries(macdLineRef.current);
      if (macdSignalRef.current && chart) chart.removeSeries(macdSignalRef.current);
      if (macdHistRef.current && chart) chart.removeSeries(macdHistRef.current);
      macdLineRef.current = null;
      macdSignalRef.current = null;
      macdHistRef.current = null;
      return;
    }

    const macdLine = chart.addLineSeries({
      color: MACD_LINE_COLOR,
      lineWidth: 1,
      priceScaleId: 'macd',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const macdSignal = chart.addLineSeries({
      color: MACD_SIGNAL_COLOR,
      lineWidth: 1,
      priceScaleId: 'macd',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const macdHist = chart.addHistogramSeries({
      priceScaleId: 'macd',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
      visible: false,
    });
    macdLineRef.current = macdLine;
    macdSignalRef.current = macdSignal;
    macdHistRef.current = macdHist;

    let cancelled = false;
    (async () => {
      try {
        const [rLine, rSig, rHist] = await Promise.all([
          api.get<IndicatorHistoryResponse>(
            `/api/indicators/history?name=macd_${encodeURIComponent(symbol)}&limit=500`,
          ),
          api.get<IndicatorHistoryResponse>(
            `/api/indicators/history?name=macd_signal_${encodeURIComponent(symbol)}&limit=500`,
          ),
          api.get<IndicatorHistoryResponse>(
            `/api/indicators/history?name=macd_hist_${encodeURIComponent(symbol)}&limit=500`,
          ),
        ]);
        if (cancelled) return;
        macdLine.setData(
          rLine.points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value })),
        );
        macdSignal.setData(
          rSig.points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value })),
        );
        macdHist.setData(
          rHist.points.map((p) => ({
            time: p.ts as UTCTimestamp,
            value: p.value,
            color: p.value >= 0 ? MACD_HIST_UP_COLOR : MACD_HIST_DOWN_COLOR,
          })),
        );
      } catch {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
      const c = chartRef.current;
      if (c) {
        if (macdLineRef.current) c.removeSeries(macdLineRef.current);
        if (macdSignalRef.current) c.removeSeries(macdSignalRef.current);
        if (macdHistRef.current) c.removeSeries(macdHistRef.current);
      }
      macdLineRef.current = null;
      macdSignalRef.current = null;
      macdHistRef.current = null;
    };
  }, [overlays.macd, symbol]);

  // ---------- Apply streamed indicator events ----------
  useEffect(() => {
    if (!lastIndicatorEvent || !symbol) return;
    const ev = lastIndicatorEvent as IndicatorEvent;
    if (ev.kind !== 'indicator') return;
    const { name, value, ts } = ev;
    if (typeof name !== 'string' || typeof value !== 'number' || typeof ts !== 'number') return;

    const time = ts as UTCTimestamp;

    // EMA
    if (overlays.ema) {
      const refs = emaSeriesRef.current;
      if (name === `ema20_${symbol}` && refs.ema20) refs.ema20.update({ time, value });
      else if (name === `ema50_${symbol}` && refs.ema50) refs.ema50.update({ time, value });
      else if (name === `ema200_${symbol}` && refs.ema200) refs.ema200.update({ time, value });
    }
    // RSI
    if (overlays.rsi && rsiSeriesRef.current && name === `rsi14_${symbol}`) {
      rsiSeriesRef.current.update({ time, value });
    }
    // MACD
    if (overlays.macd) {
      if (name === `macd_${symbol}` && macdLineRef.current) {
        macdLineRef.current.update({ time, value });
      } else if (name === `macd_signal_${symbol}` && macdSignalRef.current) {
        macdSignalRef.current.update({ time, value });
      } else if (name === `macd_hist_${symbol}` && macdHistRef.current) {
        macdHistRef.current.update({
          time,
          value,
          color: value >= 0 ? MACD_HIST_UP_COLOR : MACD_HIST_DOWN_COLOR,
        });
      }
    }
  }, [lastIndicatorEvent, symbol, overlays.ema, overlays.rsi, overlays.macd]);

  return (
    <div
      className="relative w-full h-full overflow-hidden z-[2] bg-bg-terminal isolate"
      style={height !== undefined ? { height } : undefined}
    >
      <div ref={containerRef} className="absolute inset-0" />
      <div className="absolute top-2 right-2 z-10">
        <ChartOverlays
          overlays={overlays}
          onToggle={(k, v) => setOverlays((prev) => ({ ...prev, [k]: v }))}
        />
      </div>
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
