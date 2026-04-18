'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface KvValue {
  key: string;
  value: string | null;
}

function useKv(key: string) {
  return useQuery<KvValue>({
    queryKey: ['runtime', 'kv', key],
    queryFn: () => api.get<KvValue>(`/api/runtime/kv/${key}`),
    retry: false,
    staleTime: 15_000,
  });
}

function usePutKv(key: string) {
  const qc = useQueryClient();
  return useMutation<KvValue, Error, string>({
    mutationFn: (value: string) => api.put<KvValue>(`/api/runtime/kv/${key}`, { value }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtime', 'kv', key] });
    },
  });
}

function KillSwitchRow() {
  const q = useKv('kill_switch');
  const m = usePutKv('kill_switch');
  const on = q.data?.value === 'true';

  const toggle = () => {
    m.mutate(on ? 'false' : 'true');
  };

  return (
    <div className="flex items-center gap-4 border border-border-dim bg-bg-terminal p-3">
      <div className="flex flex-col">
        <span className="pixel-font text-[11px] text-neon-red uppercase glow">Kill Switch</span>
        <span className="text-text-dim text-xs">Blocks all new orders when active.</span>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={m.isPending || q.isLoading}
        className={
          on
            ? 'ml-auto pixel-font text-[14px] px-6 py-3 border-4 border-neon-red bg-neon-red text-bg-void glow uppercase disabled:opacity-60'
            : 'ml-auto pixel-font text-[14px] px-6 py-3 border-4 border-neon-red text-neon-red glow uppercase disabled:opacity-60'
        }
      >
        {m.isPending ? '…' : on ? 'ACTIVE' : 'OFF'}
      </button>
    </div>
  );
}

interface NumberRowProps {
  kvKey: string;
  label: string;
  description: string;
  placeholder: string;
  integer?: boolean;
  allowNegative?: boolean;
}

function NumberRow({ kvKey, label, description, placeholder, integer, allowNegative }: NumberRowProps) {
  const q = useKv(kvKey);
  const m = usePutKv(kvKey);
  const [input, setInput] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const currentValue = q.data?.value ?? null;

  useEffect(() => {
    setInput(currentValue ?? '');
  }, [currentValue]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3_000);
    return () => clearTimeout(id);
  }, [toast]);

  const parse = (raw: string): number | null => {
    const v = integer ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(v)) return null;
    if (!allowNegative && v < 0) return null;
    return v;
  };

  const onSave = () => {
    const parsed = parse(input);
    if (parsed === null) {
      setToast('Invalid number');
      return;
    }
    m.mutate(String(parsed), {
      onSuccess: () => setToast('Saved'),
      onError: (err) => setToast(`Failed: ${err.message}`),
    });
  };

  return (
    <div className="flex items-center gap-3 border border-border-dim bg-bg-terminal p-3">
      <div className="flex flex-col flex-1">
        <span className="pixel-font text-[10px] text-neon-cyan uppercase">{label}</span>
        <span className="text-text-dim text-xs">{description}</span>
      </div>
      <input
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        step={integer ? '1' : '0.01'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={placeholder}
        className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-base w-32 text-right"
      />
      <button
        type="button"
        disabled={m.isPending || input === (currentValue ?? '')}
        onClick={onSave}
        className="pixel-font text-[10px] border-2 border-neon-cyan text-neon-cyan px-3 py-1 disabled:opacity-40"
      >
        {m.isPending ? 'Saving…' : 'Save'}
      </button>
      {toast && <span className="text-xs text-text-secondary ml-2">{toast}</span>}
    </div>
  );
}

// ── Live-mode DANGER ZONE ─────────────────────────────────────────────

interface PermissionsCheck {
  ok: boolean;
  enableSpotAndMarginTrading: boolean;
  enableWithdrawals: boolean;
  ipRestrict: boolean;
  detail?: Record<string, unknown> & { error?: string };
}

function LiveModeDangerZone() {
  const qc = useQueryClient();
  const modeQ = useKv('trading_mode');
  const mode = modeQ.data?.value === 'live' ? 'live' : 'paper';

  const [modalOpen, setModalOpen] = useState(false);
  const [permsResult, setPermsResult] = useState<PermissionsCheck | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [countdownStartedAt, setCountdownStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [activateError, setActivateError] = useState<string | null>(null);

  useEffect(() => {
    if (!modalOpen) {
      setPermsResult(null);
      setConfirmText('');
      setCountdownStartedAt(null);
      setActivateError(null);
    }
  }, [modalOpen]);

  useEffect(() => {
    if (!modalOpen) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [modalOpen]);

  const verifyMutation = useMutation<PermissionsCheck, Error, void>({
    mutationFn: () => api.post<PermissionsCheck>('/api/live-mode/verify-permissions', {}),
    onSuccess: (res) => setPermsResult(res),
    onError: (err) =>
      setPermsResult({
        ok: false,
        enableSpotAndMarginTrading: false,
        enableWithdrawals: false,
        ipRestrict: false,
        detail: { error: err.message },
      }),
  });

  const activateMutation = useMutation<
    { ok?: boolean; tradingMode?: string; error?: string; detail?: string } & PermissionsCheck,
    Error,
    void
  >({
    mutationFn: () =>
      api.post('/api/live-mode/activate', { confirmationText: confirmText }),
    onSuccess: () => {
      setModalOpen(false);
      void qc.invalidateQueries({ queryKey: ['runtime', 'kv', 'trading_mode'] });
    },
    onError: (err) => setActivateError(err.message),
  });

  const deactivateMutation = useMutation<
    { ok?: boolean; tradingMode?: string },
    Error,
    void
  >({
    mutationFn: () => api.post('/api/live-mode/deactivate', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtime', 'kv', 'trading_mode'] });
    },
  });

  const countdownMs = 5000;
  const elapsed = countdownStartedAt !== null ? now - countdownStartedAt : 0;
  const remainingS = Math.max(0, Math.ceil((countdownMs - elapsed) / 1000));
  const countdownActive = countdownStartedAt !== null && elapsed < countdownMs;

  const confirmOk = confirmText === 'ACTIVATE LIVE';
  const canSubmit =
    confirmOk &&
    permsResult?.ok === true &&
    !countdownActive &&
    countdownStartedAt !== null;

  const startCountdown = () => {
    if (!confirmOk || permsResult?.ok !== true) return;
    setCountdownStartedAt(Date.now());
    setNow(Date.now());
  };

  return (
    <div className="flex flex-col gap-3 border-4 border-neon-amber bg-bg-terminal p-4">
      <div className="flex items-center justify-between">
        <h3 className="pixel-font text-[13px] text-neon-amber uppercase glow">
          LIVE TRADING — DANGER ZONE
        </h3>
        {mode === 'live' ? (
          <span className="pixel-font text-[10px] px-3 py-1 border-2 bg-neon-red text-bg-void border-neon-red uppercase animate-pulse glow">
            ● LIVE
          </span>
        ) : (
          <span className="pixel-font text-[10px] px-3 py-1 border-2 border-neon-green text-neon-green uppercase">
            PAPER
          </span>
        )}
      </div>

      <p className="text-text-secondary text-xs">
        Live mode submits real orders to Binance using your stored API key.
        Paper mode is the safe default. You must pass the permissions check
        and type the confirmation phrase to switch into live mode.
      </p>

      <div className="flex gap-2">
        {mode === 'paper' ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="pixel-font text-[11px] px-4 py-3 border-4 border-neon-red text-neon-red uppercase glow hover:bg-neon-red hover:text-bg-void"
          >
            ENABLE LIVE
          </button>
        ) : (
          <button
            type="button"
            onClick={() => deactivateMutation.mutate()}
            disabled={deactivateMutation.isPending}
            className="pixel-font text-[11px] px-4 py-3 border-4 border-neon-green text-neon-green uppercase glow hover:bg-neon-green hover:text-bg-void disabled:opacity-50"
          >
            {deactivateMutation.isPending ? '…' : 'DISABLE LIVE'}
          </button>
        )}
      </div>

      {mode === 'live' && (
        <div className="flex flex-col gap-2">
          <NumberRow
            kvKey="live_max_orders_per_day"
            label="Live: Max Orders / Day"
            description="Hard daily cap on ccxt live orders. Default 20."
            placeholder="20"
            integer
          />
          <NumberRow
            kvKey="live_order_global_cooldown_seconds"
            label="Live: Global Cooldown (s)"
            description="Min seconds between any two live orders. Default 30."
            placeholder="30"
            integer
          />
        </div>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 bg-bg-void/80 flex items-center justify-center z-50"
          onClick={() => {
            if (!activateMutation.isPending) setModalOpen(false);
          }}
        >
          <div
            className="bg-bg-terminal border-4 border-neon-red p-6 max-w-lg w-full flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="pixel-font text-[14px] text-neon-red glow uppercase">
              ACTIVATE LIVE TRADING
            </h2>

            <div className="border-2 border-neon-amber text-neon-amber p-3 pixel-font text-[10px] leading-5 uppercase">
              WARNING: Live mode places real orders with your Binance key and
              can move real money. There is no undo. Only proceed if you
              understand the risk and have set appropriate risk limits.
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="pixel-font text-[10px] text-neon-cyan uppercase">
                  1. Key Permissions Check
                </span>
                <button
                  type="button"
                  onClick={() => verifyMutation.mutate()}
                  disabled={verifyMutation.isPending}
                  className="pixel-font text-[10px] px-3 py-1 border-2 border-neon-cyan text-neon-cyan disabled:opacity-50"
                >
                  {verifyMutation.isPending ? 'CHECKING…' : 'CHECK PERMISSIONS'}
                </button>
              </div>
              {permsResult && (
                <div className="flex flex-col gap-1 border border-border-dim bg-bg-void p-3 pixel-font text-[10px]">
                  <CheckLine
                    ok={permsResult.enableSpotAndMarginTrading}
                    label="Spot trading enabled"
                  />
                  <CheckLine
                    ok={!permsResult.enableWithdrawals}
                    label="Withdrawals disabled"
                    required
                  />
                  <CheckLine
                    ok={permsResult.ipRestrict}
                    label="IP whitelisted (informational)"
                    informational
                  />
                  {permsResult.detail?.error && (
                    <div className="text-neon-red text-[9px] uppercase mt-1">
                      {String(permsResult.detail.error)}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <span className="pixel-font text-[10px] text-neon-cyan uppercase">
                2. Type &quot;ACTIVATE LIVE&quot; exactly
              </span>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="ACTIVATE LIVE"
                className="bg-bg-void border border-border-dim px-3 py-2 vt-font text-base tracking-widest"
                autoCapitalize="characters"
              />
              <div className="pixel-font text-[9px] uppercase">
                {confirmOk ? (
                  <span className="text-neon-green">✓ CONFIRMATION MATCHES</span>
                ) : (
                  <span className="text-text-dim">Waiting for exact match…</span>
                )}
              </div>
            </div>

            {activateError && (
              <div className="border-2 border-neon-red text-neon-red pixel-font text-[10px] px-3 py-2 uppercase">
                {activateError}
              </div>
            )}

            <div className="flex gap-2 justify-end pt-2">
              <button
                type="button"
                className="pixel-font text-[10px] px-4 py-2 border-2 border-border-dim text-text-secondary hover:border-neon-cyan hover:text-neon-cyan"
                disabled={activateMutation.isPending}
                onClick={() => setModalOpen(false)}
              >
                CANCEL
              </button>
              {countdownStartedAt === null ? (
                <button
                  type="button"
                  disabled={!confirmOk || permsResult?.ok !== true}
                  onClick={startCountdown}
                  className="pixel-font text-[10px] px-4 py-2 border-2 bg-neon-red text-bg-void border-neon-red disabled:opacity-40 disabled:cursor-not-allowed uppercase"
                >
                  START 5s COUNTDOWN
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canSubmit || activateMutation.isPending}
                  onClick={() => activateMutation.mutate()}
                  className="pixel-font text-[10px] px-4 py-2 border-2 bg-neon-red text-bg-void border-neon-red disabled:opacity-40 disabled:cursor-not-allowed uppercase"
                >
                  {activateMutation.isPending
                    ? 'ACTIVATING…'
                    : countdownActive
                      ? `ACTIVATE (${remainingS}s)`
                      : 'ACTIVATE NOW'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckLine({
  ok,
  label,
  required,
  informational,
}: {
  ok: boolean;
  label: string;
  required?: boolean;
  informational?: boolean;
}) {
  if (informational) {
    return (
      <div
        className={
          ok ? 'text-neon-green' : 'text-text-dim'
        }
      >
        {ok ? '☑' : '○'} {label}
      </div>
    );
  }
  if (ok) {
    return <div className="text-neon-green">☑ {label}</div>;
  }
  return (
    <div className="text-neon-red">
      ✗ {label}
      {required ? ' (REQUIRED)' : ''}
    </div>
  );
}

export function ExecutionKnobs() {
  return (
    <div className="flex flex-col gap-3">
      <KillSwitchRow />
      <NumberRow
        kvKey="max_order_notional"
        label="Max Order Notional ($)"
        description="Per-order USD notional cap."
        placeholder="500"
      />
      <NumberRow
        kvKey="max_open_positions_per_asset"
        label="Max Open Positions / Asset"
        description="How many concurrent legs per asset."
        placeholder="1"
        integer
      />
      <NumberRow
        kvKey="daily_loss_cap"
        label="Daily Loss Cap ($)"
        description="Negative. If today's PnL hits this, new orders blocked."
        placeholder="-1000"
        allowNegative
      />
      <NumberRow
        kvKey="order_cooldown_seconds"
        label="Order Cooldown (s)"
        description="Minimum seconds between orders on the same asset."
        placeholder="10"
        integer
      />
      <LiveModeDangerZone />
    </div>
  );
}

export default ExecutionKnobs;
