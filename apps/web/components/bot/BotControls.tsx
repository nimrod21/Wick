'use client';

/**
 * Header controls (task 6.4): start/stop are instant, reset is confirmed,
 * "allowance" is the bot's daily trade budget (`max_trades_day`) edited
 * inline, and the full config lives behind the drawer.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Bot, type BotConfig } from '@/lib/api';
import { Btn, PixelTitle, StatusLed } from '@/components/ui';
import { ConfigDrawer } from './ConfigDrawer';

export function BotControls({ bot }: { bot: Bot }) {
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [allowance, setAllowance] = useState(String(bot.config.max_trades_day));
  const [error, setError] = useState<string | null>(null);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['bot', bot.id] });
    void qc.invalidateQueries({ queryKey: ['bots'] });
  };

  const action = useMutation({
    mutationFn: (a: 'start' | 'stop' | 'reset') => api.botAction(bot.id, a),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message),
  });

  const patch = useMutation({
    mutationFn: (config: Partial<BotConfig>) => api.patchBot(bot.id, { config }),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message),
  });

  const saveAllowance = (): void => {
    const n = Number(allowance);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      setError('allowance must be an integer 0–100');
      return;
    }
    setError(null);
    patch.mutate({ max_trades_day: n });
  };

  return (
    <div className="panel p-3">
      <div className="flex flex-wrap items-center gap-3">
        <PixelTitle as="h1" className="text-fg">
          {bot.name}
        </PixelTitle>
        <StatusLed status={bot.status} label />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
            allowance
            <input
              type="number"
              className="w-16 py-0.5 text-xs"
              value={allowance}
              onChange={(e) => setAllowance(e.target.value)}
              onBlur={saveAllowance}
            />
            <span className="normal-case">trades/day</span>
          </label>

          <Btn
            tone="go"
            onClick={() => action.mutate('start')}
            disabled={bot.status === 'running' || bot.status === 'busted' || action.isPending}
            title={bot.status === 'busted' ? 'a busted bot must be reset first' : undefined}
          >
            start
          </Btn>
          <Btn tone="warn" onClick={() => action.mutate('stop')} disabled={bot.status === 'stopped' || action.isPending}>
            stop
          </Btn>
          <Btn
            tone="danger"
            onClick={() => {
              if (window.confirm(`Reset ${bot.name}? Positions liquidate at mid and cash returns to $${bot.bankrollStart}.`)) {
                action.mutate('reset');
              }
            }}
            disabled={action.isPending}
          >
            reset
          </Btn>
          <Btn onClick={() => setDrawer(true)}>config</Btn>
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red">{error}</p>}

      {drawer && (
        <ConfigDrawer
          bot={bot}
          onClose={() => setDrawer(false)}
          onSave={async (config) => {
            await patch.mutateAsync(config);
          }}
        />
      )}
    </div>
  );
}
