'use client';

/**
 * Global live feed: last ~30 decisions / fills / protector exits /
 * bot-status changes, newest on top, slide-in only. Gated triggers are
 * deliberately NOT here — they live on the bot page's trigger tab (task 6.3).
 */

import { useState } from 'react';
import Link from 'next/link';
import { ActionBadge, Empty, Panel } from '@/components/ui';
import { useLive } from '@/lib/sse';
import { clock, price, shortSymbol, usd } from '@/lib/format';

const MAX = 30;

interface FeedRow {
  key: string;
  ts: number;
  botId: number | null;
  kind: 'decision' | 'fill' | 'bot_status';
  action?: string;
  status?: string;
  symbol: string | null;
  text: string;
}

export function LiveFeed({ botNames }: { botNames: Map<number, string> }) {
  const [rows, setRows] = useState<FeedRow[]>([]);

  const push = (row: FeedRow): void =>
    setRows((prev) => [row, ...prev.filter((r) => r.key !== row.key)].slice(0, MAX));

  useLive('decision', (e) => {
    push({
      key: `d${e.decisionId}`,
      ts: e.ts,
      botId: e.botId,
      kind: 'decision',
      action: e.action,
      status: e.status,
      symbol: e.symbol,
      text:
        e.status === 'vetoed'
          ? `vetoed: ${e.vetoReason ?? 'guard'}`
          : e.status === 'llm_failed'
            ? 'no provider answered'
            : `${e.triggerType}${e.confidence === null ? '' : ` · conf ${e.confidence}`}`,
    });
  });

  useLive('fill', (e) => {
    push({
      key: `f${e.id}-${e.ts}`,
      ts: e.ts,
      botId: e.botId,
      kind: 'fill',
      action: e.side,
      symbol: e.symbol,
      text: `${e.reason === 'trade' ? 'fill' : `${e.reason.toUpperCase()} exit`} ${e.qty.toFixed(4)} @ ${price(e.price)} · ${usd(e.notional, 0)}`,
    });
  });

  useLive('bot_status', (e) => {
    push({
      key: `s${e.botId}-${e.ts}`,
      ts: e.ts,
      botId: e.botId,
      kind: 'bot_status',
      status: e.status,
      symbol: null,
      text: `${e.status} — ${e.reason}`,
    });
  });

  return (
    <Panel title="Live feed" bodyClassName="max-h-[520px] overflow-y-auto p-0">
      {rows.length === 0 ? (
        <Empty>waiting for events…</Empty>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.key} className="slide-in flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs last:border-0">
              <span className="tnum w-14 shrink-0 text-muted">{clock(r.ts)}</span>
              <span className="w-24 shrink-0 truncate text-muted">
                {r.botId === null ? '—' : (
                  <Link href={`/bots/${r.botId}`} className="hover:text-cyan">
                    {botNames.get(r.botId) ?? `bot ${r.botId}`}
                  </Link>
                )}
              </span>
              <span className="w-16 shrink-0">
                {r.kind === 'bot_status' ? (
                  <span className="text-[10px] uppercase text-muted">status</span>
                ) : (
                  <ActionBadge action={r.action ?? '?'} status={r.status} />
                )}
              </span>
              <span className="w-12 shrink-0 text-muted">{r.symbol ? shortSymbol(r.symbol) : ''}</span>
              <span className="truncate text-muted">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
