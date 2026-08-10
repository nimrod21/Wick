'use client';

/**
 * Indicator track record (IMPL-2): does this indicator actually call the
 * direction, and what has the learner done with its weight.
 *
 * Honesty rule from the spec: nothing here may render blank on day one. Below
 * the sample floor an indicator shows "collecting samples: n/30" instead of a
 * hit-rate, because a hit-rate off 4 samples is noise and the weight is frozen
 * by design until the floor is passed.
 */

import { useState } from 'react';
import type { IndicatorRollup, IndicatorRollupRow } from '@/lib/api';
import { Empty, Panel, Sparkline, WeightBar } from '@/components/ui';
import { dateTime } from '@/lib/format';

function HitRate({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-muted">—</span>;
  return (
    <span className={rate >= 0.5 ? 'text-green' : 'text-red'}>{(rate * 100).toFixed(0)}%</span>
  );
}

/** The under-sampled state — a progress counter, never a blank cell. */
function Collecting({ samples, floor }: { samples: number; floor: number }) {
  const frac = Math.max(0, Math.min(1, samples / floor));
  return (
    <span className="inline-flex items-center gap-2" title={`weights stay frozen until ${floor} scored votes`}>
      <span className="inline-block h-1.5 w-16 bg-line" aria-hidden>
        <span className="block h-full bg-cyan" style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="tnum text-[10px] text-muted">
        collecting samples: {samples}/{floor}
      </span>
    </span>
  );
}

function IndicatorRowView({
  row,
  floor,
  disableFloor,
  open,
  onToggle,
}: {
  row: IndicatorRollupRow;
  floor: number;
  disableFloor: number;
  open: boolean;
  onToggle: () => void;
}) {
  const below = row.samples < floor;
  const shadow = row.botCount > 0 && row.enabledBots === 0;
  const history = row.history.map((h) => h.weight);

  return (
    <>
      <tr id={`ind-${row.indicator}`} className={`border-b border-line ${shadow ? 'opacity-50' : ''}`}>
        <td className="px-3 py-1">
          <button type="button" onClick={onToggle} className="text-left hover:text-cyan" title={row.rule || undefined}>
            <span className="text-muted">{open ? '▾' : '▸'}</span> {row.indicator}
          </button>
          {row.scope === 'global' && (
            <span className="ml-2 border border-line px-1 text-[9px] uppercase text-muted">global</span>
          )}
          {!row.registered && (
            <span className="ml-2 border border-line px-1 text-[9px] uppercase text-muted" title="stats exist but the indicator is no longer registered">
              retired
            </span>
          )}
        </td>
        <td className="tnum px-3 py-1 text-muted">
          {row.samples} <span className="text-[10px]">({row.hits} hit)</span>
        </td>
        <td className="tnum px-3 py-1">
          {below ? <Collecting samples={row.samples} floor={floor} /> : <HitRate rate={row.hitRate} />}
        </td>
        <td className="px-3 py-1">
          {row.weight === null ? <span className="text-muted">—</span> : <WeightBar weight={row.weight} />}
        </td>
        <td className="px-3 py-1">
          {history.length === 0 ? (
            <span className="text-[10px] text-muted" title="one point is appended per indicator on each daily recompute">
              no history yet
            </span>
          ) : (
            <span className="inline-flex items-center gap-2" title={`${history.length} daily point(s)`}>
              <Sparkline values={history} width={80} height={16} />
              <span className="tnum text-[10px] text-muted">{history.length}d</span>
            </span>
          )}
        </td>
        <td className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted">
          {row.botCount === 0
            ? 'no samples'
            : `${row.enabledBots}/${row.botCount} enabled${shadow ? ' · shadow' : ''}`}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line">
          <td colSpan={6} className="bg-panel px-3 py-2">
            <p className="mb-2 text-[10px] text-muted">
              {row.rule || 'no rule registered'} — auto-disabled below 45% hit-rate once {disableFloor}{' '}
              samples exist; disabled indicators keep voting in shadow.
            </p>
            {row.bots.length === 0 ? (
              <p className="text-[10px] text-muted">
                no bot has scored this indicator yet — samples accrue when 4h outcomes are evaluated
              </p>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted">
                    <th className="py-1 pr-3 font-normal">bot</th>
                    <th className="py-1 pr-3 font-normal">samples</th>
                    <th className="py-1 pr-3 font-normal">hit-rate</th>
                    <th className="py-1 pr-3 font-normal">weight</th>
                    <th className="py-1 pr-3 font-normal">state</th>
                    <th className="py-1 pr-3 font-normal">updated</th>
                  </tr>
                </thead>
                <tbody>
                  {row.bots.map((b) => (
                    <tr key={b.botId} className={b.enabled ? '' : 'opacity-50'}>
                      <td className="py-1 pr-3">{b.botName ?? `bot ${b.botId}`}</td>
                      <td className="tnum py-1 pr-3 text-muted">
                        {b.samples} ({b.hits} hit)
                      </td>
                      <td className="tnum py-1 pr-3">
                        {b.samples < floor ? (
                          <span className="text-muted">
                            {b.samples}/{floor}
                          </span>
                        ) : (
                          <HitRate rate={b.hitRate} />
                        )}
                      </td>
                      <td className="py-1 pr-3">
                        <WeightBar weight={b.weight} />
                      </td>
                      <td className="py-1 pr-3 text-[10px] uppercase tracking-wider text-muted">
                        {b.enabled ? 'enabled' : 'shadow'}
                      </td>
                      <td className="tnum py-1 pr-3 text-muted">{dateTime(b.updatedTs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function TrackRecord({
  rollup,
  focus,
}: {
  rollup: IndicatorRollup | undefined;
  focus: string | null;
}) {
  const [open, setOpen] = useState<string | null>(focus);

  if (!rollup) return <Empty>loading track record…</Empty>;
  if (rollup.indicators.length === 0) return <Empty>no indicators registered</Empty>;

  const scored = rollup.indicators.filter((i) => i.samples >= rollup.sampleFloor).length;

  return (
    <Panel
      title="Track record — hit-rate and weight per indicator (all bots)"
      right={
        <span className="text-[10px] uppercase tracking-wider text-muted">
          {scored}/{rollup.indicators.length} past the {rollup.sampleFloor}-sample floor
        </span>
      }
      bodyClassName="p-0"
    >
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-muted">
            <th className="px-3 py-1 font-normal">indicator</th>
            <th className="px-3 py-1 font-normal">samples</th>
            <th className="px-3 py-1 font-normal">hit-rate</th>
            <th className="px-3 py-1 font-normal">weight</th>
            <th className="px-3 py-1 font-normal">weight trend</th>
            <th className="px-3 py-1 font-normal">state</th>
          </tr>
        </thead>
        <tbody>
          {rollup.indicators.map((row) => (
            <IndicatorRowView
              key={row.indicator}
              row={row}
              floor={rollup.sampleFloor}
              disableFloor={rollup.disableFloor}
              open={open === row.indicator}
              onToggle={() => setOpen(open === row.indicator ? null : row.indicator)}
            />
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-1 text-[10px] text-muted">
        one sample = one indicator vote on a decision whose 4h outcome was scored (neutral votes and
        moves inside the ±0.3% dead band are skipped). Weights move only past the sample floor.
      </p>
    </Panel>
  );
}
