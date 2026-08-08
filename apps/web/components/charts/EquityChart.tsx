'use client';

/**
 * Equity curve from `equity_snapshots` (never recomputed client-side —
 * IMPL-4 Phase 6 pitfall 4): equity line, dashed running high-water mark,
 * and the drawdown gap between them shaded red.
 *
 * The shading is two stacked area series: a red-tinted area on the HWM
 * (fills hwm → pane bottom), then an OPAQUE panel-colored area on the equity
 * (fills equity → pane bottom) painted over it. What survives is exactly the
 * band between hwm and equity. lightweight-charts v4 has no band series.
 */

import { useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { CHART_OPTIONS, HEX } from '@/lib/chart-theme';

export interface EquityPoint {
  ts: number;
  equity: number;
}

interface Series {
  ddBand: ISeriesApi<'Area'>;
  mask: ISeriesApi<'Area'>;
  hwm: ISeriesApi<'Line'>;
  equity: ISeriesApi<'Line'>;
}

export function EquityChart({
  snapshots,
  height = 200,
}: {
  snapshots: EquityPoint[];
  height?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Series | null>(null);
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
      const quiet = {
        lineWidth: 1 as const,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      };
      seriesRef.current = {
        ddBand: chart.addAreaSeries({
          ...quiet,
          lineColor: 'rgba(0,0,0,0)',
          topColor: 'rgba(255, 56, 96, 0.22)',
          bottomColor: 'rgba(255, 56, 96, 0.22)',
        }),
        mask: chart.addAreaSeries({
          ...quiet,
          lineColor: 'rgba(0,0,0,0)',
          topColor: HEX.panel,
          bottomColor: HEX.panel,
        }),
        hwm: chart.addLineSeries({ ...quiet, color: HEX.border, lineStyle: 2 }),
        equity: chart.addLineSeries({ color: HEX.green, lineWidth: 2, priceLineVisible: false }),
      };
      observer = new ResizeObserver(() => {
        if (boxRef.current) chart.applyOptions({ width: boxRef.current.clientWidth });
      });
      observer.observe(box);
      setReady(true);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      seriesRef.current = null;
      chartRef.current?.remove();
      chartRef.current = null;
      setReady(false);
    };
  }, [height]);

  useEffect(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (!ready || !s || !chart) return;

    let peak = Number.NEGATIVE_INFINITY;
    const equity: Array<{ time: UTCTimestamp; value: number }> = [];
    const hwm: Array<{ time: UTCTimestamp; value: number }> = [];
    for (const p of snapshots) {
      const time = Math.floor(p.ts / 1000) as UTCTimestamp;
      peak = Math.max(peak, p.equity);
      equity.push({ time, value: p.equity });
      hwm.push({ time, value: peak });
    }
    s.ddBand.setData(hwm);
    s.mask.setData(equity);
    s.hwm.setData(hwm);
    s.equity.setData(equity);
    chart.timeScale().fitContent();
  }, [ready, snapshots]);

  return <div ref={boxRef} style={{ height }} className="w-full" />;
}
