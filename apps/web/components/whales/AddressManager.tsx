'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Chain = 'eth' | 'sol' | 'btc';

interface WhaleAddress {
  id: number;
  chain: Chain;
  address: string;
  label: string | null;
  tags: string[];
  enabled: boolean;
  added_at: number;
  last_checked_ts: number | null;
}

interface WhalesResponse {
  whales: WhaleAddress[];
}

interface IgnoreEntry {
  id: number;
  chain: Chain;
  address: string;
  reason: string | null;
  added_at: number;
}

interface IgnoreResponse {
  ignored: IgnoreEntry[];
}

interface AddressManagerProps {
  chain: Chain;
}

function shortenAddress(addr: string): string {
  if (!addr) return '';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}…${addr.slice(-4)}`;
}

export function AddressManager({ chain }: AddressManagerProps) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [showIgnore, setShowIgnore] = useState(false);
  const [addAddr, setAddAddr] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [addTags, setAddTags] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const whalesQuery = useQuery<WhalesResponse>({
    queryKey: ['whales-list', chain],
    queryFn: () => api.get<WhalesResponse>(`/api/whales?chain=${chain}`),
    staleTime: 30_000,
  });

  const addMut = useMutation({
    mutationFn: (payload: {
      chain: Chain;
      address: string;
      label: string | null;
      tags: string[];
    }) => api.post<{ id: number }>('/api/whales', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whales-list', chain] });
      setAddAddr('');
      setAddLabel('');
      setAddTags('');
      setShowAdd(false);
      setFormError(null);
    },
    onError: (err: Error) => {
      setFormError(err.message || 'FAILED TO ADD');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.del<void>(`/api/whales/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whales-list', chain] });
    },
  });

  const toggleMut = useMutation({
    mutationFn: (w: WhaleAddress) =>
      api.put<void>(`/api/whales/${w.id}`, { enabled: !w.enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whales-list', chain] });
    },
  });

  const whales = useMemo(
    () => whalesQuery.data?.whales ?? [],
    [whalesQuery.data],
  );

  const onSubmitAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const address = addAddr.trim();
    if (!address) {
      setFormError('ADDRESS REQUIRED');
      return;
    }
    const tags = addTags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    addMut.mutate({
      chain,
      address,
      label: addLabel.trim() || null,
      tags,
    });
  };

  return (
    <div className="flex flex-col gap-2 p-2 border border-border-dim bg-bg-terminal overflow-y-auto min-h-0">
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => {
            setShowAdd((v) => !v);
            setFormError(null);
          }}
          className="pixel-font text-[9px] px-2 py-1 border-2 border-neon-magenta text-neon-magenta hover:bg-neon-magenta hover:text-bg-void"
        >
          {showAdd ? 'CANCEL' : '+ ADD ADDRESS'}
        </button>
        <button
          type="button"
          onClick={() => setShowIgnore(true)}
          className="pixel-font text-[9px] px-2 py-1 border-2 border-border-dim text-text-secondary hover:border-neon-cyan hover:text-neon-cyan"
        >
          MANAGE IGNORE LIST
        </button>
      </div>

      {showAdd && (
        <form
          onSubmit={onSubmitAdd}
          className="flex flex-col gap-2 p-2 border border-neon-magenta bg-bg-elevated"
        >
          <label className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Address
            </span>
            <input
              type="text"
              value={addAddr}
              onChange={(e) => setAddAddr(e.target.value)}
              placeholder="0x… / Solana / bc1…"
              className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Label
            </span>
            <input
              type="text"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="e.g. VITALIK"
              className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Tags (comma-separated)
            </span>
            <input
              type="text"
              value={addTags}
              onChange={(e) => setAddTags(e.target.value)}
              placeholder="founder,vc"
              className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-sm"
            />
          </label>
          {formError && (
            <span className="pixel-font text-[8px] text-neon-red">
              {formError}
            </span>
          )}
          <button
            type="submit"
            disabled={addMut.isPending}
            className="pixel-font text-[9px] px-2 py-1 bg-neon-magenta text-bg-void border-2 border-neon-magenta disabled:opacity-40"
          >
            {addMut.isPending ? 'SAVING…' : 'SAVE'}
          </button>
        </form>
      )}

      <div className="flex flex-col gap-1 mt-1">
        {whalesQuery.isLoading ? (
          <div className="vt-font text-text-dim text-sm px-2 py-1">LOADING…</div>
        ) : whales.length === 0 ? (
          <div className="vt-font text-text-dim text-sm px-2 py-1">
            NO ADDRESSES TRACKED
          </div>
        ) : (
          whales.map((w) => (
            <div
              key={w.id}
              className="flex flex-col gap-1 px-2 py-1 border-l-2 border-transparent hover:border-neon-magenta hover:bg-bg-elevated"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="vt-font text-[15px] text-neon-cyan truncate"
                  title={w.address}
                >
                  {w.label || shortenAddress(w.address)}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => toggleMut.mutate(w)}
                    className={`pixel-font text-[8px] px-2 py-0.5 border-2 ${
                      w.enabled
                        ? 'border-neon-green text-neon-green'
                        : 'border-border-dim text-text-dim'
                    }`}
                    title={w.enabled ? 'Click to disable' : 'Click to enable'}
                  >
                    {w.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete ${w.label || w.address}?`)) {
                        deleteMut.mutate(w.id);
                      }
                    }}
                    className="pixel-font text-[8px] px-2 py-0.5 border-2 border-border-dim text-text-dim hover:border-neon-red hover:text-neon-red"
                    title="Delete"
                  >
                    X
                  </button>
                </div>
              </div>
              {w.label && (
                <span
                  className="vt-font text-[12px] text-text-dim truncate"
                  title={w.address}
                >
                  {shortenAddress(w.address)}
                </span>
              )}
              {w.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {w.tags.map((tag) => (
                    <span
                      key={tag}
                      className="pixel-font text-[8px] px-1 py-0.5 border border-neon-purple text-neon-purple"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {showIgnore && (
        <IgnoreListModal chain={chain} onClose={() => setShowIgnore(false)} />
      )}
    </div>
  );
}

interface IgnoreListModalProps {
  chain: Chain;
  onClose: () => void;
}

function IgnoreListModal({ chain, onClose }: IgnoreListModalProps) {
  const qc = useQueryClient();
  const [newAddr, setNewAddr] = useState('');
  const [newReason, setNewReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const ignoreQuery = useQuery<IgnoreResponse>({
    queryKey: ['whales-ignore', chain],
    queryFn: () => api.get<IgnoreResponse>(`/api/whales/ignore?chain=${chain}`),
    staleTime: 30_000,
  });

  const addMut = useMutation({
    mutationFn: (payload: { chain: Chain; address: string; reason: string | null }) =>
      api.post<{ id: number }>('/api/whales/ignore', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whales-ignore', chain] });
      setNewAddr('');
      setNewReason('');
      setErr(null);
    },
    onError: (e: Error) => setErr(e.message || 'FAILED'),
  });

  const delMut = useMutation({
    mutationFn: (id: number) => api.del<void>(`/api/whales/ignore/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whales-ignore', chain] });
    },
  });

  const entries = ignoreQuery.data?.ignored ?? [];

  return (
    <div
      className="fixed inset-0 bg-bg-void/80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-bg-terminal border-2 border-neon-magenta p-4 w-[520px] max-w-[90vw] max-h-[80vh] flex flex-col gap-3 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="pixel-font text-[11px] text-neon-magenta glow uppercase">
            Ignore List · {chain.toUpperCase()}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="pixel-font text-[9px] px-2 py-1 border-2 border-border-dim text-text-secondary hover:border-neon-red hover:text-neon-red"
          >
            CLOSE
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const address = newAddr.trim();
            if (!address) {
              setErr('ADDRESS REQUIRED');
              return;
            }
            addMut.mutate({
              chain,
              address,
              reason: newReason.trim() || null,
            });
          }}
          className="flex flex-col gap-2 p-2 border border-border-dim"
        >
          <label className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Address to Ignore
            </span>
            <input
              type="text"
              value={newAddr}
              onChange={(e) => setNewAddr(e.target.value)}
              className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Reason (optional)
            </span>
            <input
              type="text"
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              placeholder="exchange hot wallet / spam / …"
              className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-sm"
            />
          </label>
          {err && (
            <span className="pixel-font text-[8px] text-neon-red">{err}</span>
          )}
          <button
            type="submit"
            disabled={addMut.isPending}
            className="pixel-font text-[9px] px-2 py-1 bg-neon-magenta text-bg-void border-2 border-neon-magenta disabled:opacity-40"
          >
            {addMut.isPending ? 'SAVING…' : 'ADD TO IGNORE'}
          </button>
        </form>

        <div className="flex flex-col gap-1 overflow-y-auto">
          {ignoreQuery.isLoading ? (
            <div className="vt-font text-text-dim text-sm px-2 py-1">LOADING…</div>
          ) : entries.length === 0 ? (
            <div className="vt-font text-text-dim text-sm px-2 py-1">
              IGNORE LIST EMPTY
            </div>
          ) : (
            entries.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between gap-2 px-2 py-1 border border-border-dim"
              >
                <div className="flex flex-col min-w-0">
                  <span
                    className="vt-font text-[13px] text-text-primary truncate"
                    title={e.address}
                  >
                    {shortenAddress(e.address)}
                  </span>
                  {e.reason && (
                    <span className="vt-font text-[11px] text-text-dim truncate">
                      {e.reason}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => delMut.mutate(e.id)}
                  className="pixel-font text-[8px] px-2 py-0.5 border-2 border-border-dim text-text-dim hover:border-neon-red hover:text-neon-red shrink-0"
                >
                  REMOVE
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default AddressManager;
