/**
 * lightweight-charts theme matched to the Wick palette (PLAN §12).
 * Canvas needs literal colors — CSS variables do not resolve there, so the
 * hexes are duplicated here and must stay in sync with `globals.css`.
 */

export const HEX = {
  bg: '#0B0B10',
  panel: '#12121A',
  border: '#2A2A38',
  green: '#33FF66',
  amber: '#FFB000',
  cyan: '#2DE2E6',
  red: '#FF3860',
  fg: '#E6E6EE',
  muted: '#8A8A9E',
  /** Desaturated candle bodies (PLAN §12) — full phosphor is for badges. */
  candleUp: '#2E9E4B',
  candleDown: '#A32B43',
} as const;

export const CHART_OPTIONS = {
  layout: {
    background: { color: HEX.panel },
    textColor: HEX.muted,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 10,
  },
  grid: {
    vertLines: { color: HEX.border, style: 1 },
    horzLines: { color: HEX.border, style: 1 },
  },
  rightPriceScale: { borderColor: HEX.border },
  timeScale: { borderColor: HEX.border, timeVisible: true, secondsVisible: false },
  crosshair: {
    vertLine: { color: HEX.border, labelBackgroundColor: HEX.border },
    horzLine: { color: HEX.border, labelBackgroundColor: HEX.border },
  },
  handleScale: { axisPressedMouseMove: false },
} as const;

export const CANDLE_COLORS = {
  upColor: HEX.candleUp,
  downColor: HEX.candleDown,
  borderUpColor: HEX.candleUp,
  borderDownColor: HEX.candleDown,
  wickUpColor: HEX.candleUp,
  wickDownColor: HEX.candleDown,
} as const;
