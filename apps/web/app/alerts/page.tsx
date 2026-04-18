'use client';

import { useEffect, useState } from 'react';
import { RuleList } from '@/components/alerts/RuleList';
import { FiringHistory } from '@/components/alerts/FiringHistory';
import { RuleBuilder } from '@/components/alerts/RuleBuilder';
import { getPermission, requestPermission } from '@/lib/notifications';

export default function AlertsPage() {
  const [builderOpen, setBuilderOpen] = useState<'new' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>('default');

  // Refresh permission on mount. Do NOT auto-prompt — show a banner instead.
  useEffect(() => {
    setNotifPermission(getPermission());
  }, []);

  const askPermission = async () => {
    const p = await requestPermission();
    setNotifPermission(p);
  };

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between">
        <h1 className="pixel-font text-neon-red glow text-xs">ALERTS</h1>
        <button
          type="button"
          className="pixel-font text-[10px] px-3 py-1 border-2 border-neon-cyan text-neon-cyan"
          onClick={() => {
            setEditingId(null);
            setBuilderOpen('new');
          }}
        >
          + NEW RULE
        </button>
      </div>

      {notifPermission === 'default' && (
        <div className="flex items-center gap-3 border-2 border-neon-amber bg-bg-terminal px-3 py-2">
          <span className="pixel-font text-[10px] text-neon-amber glow uppercase">
            Enable browser notifications
          </span>
          <span className="vt-font text-[13px] text-text-secondary flex-1">
            Browser alerts fire outside the tab. They require your one-time permission.
          </span>
          <button
            type="button"
            onClick={() => void askPermission()}
            className="pixel-font text-[9px] px-3 py-1 border-2 border-neon-amber text-neon-amber"
          >
            ENABLE
          </button>
        </div>
      )}
      {notifPermission === 'denied' && (
        <div className="flex items-center gap-3 border-2 border-neon-red bg-bg-terminal px-3 py-2">
          <span className="pixel-font text-[10px] text-neon-red glow uppercase">
            Notifications denied
          </span>
          <span className="vt-font text-[13px] text-text-secondary">
            Firings still land in the history panel and SSE stream.
          </span>
        </div>
      )}

      <div className="grid grid-cols-[1fr_1fr] gap-4 flex-1 min-h-0">
        <RuleList
          onEdit={(id) => {
            setEditingId(id);
            setBuilderOpen('edit');
          }}
        />
        <FiringHistory />
      </div>

      {builderOpen && (
        <RuleBuilder
          mode={builderOpen}
          ruleId={editingId}
          onClose={() => setBuilderOpen(null)}
        />
      )}
    </div>
  );
}
