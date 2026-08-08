'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Panel, PixelTitle } from '@/components/ui';
import { ProvidersPanel } from '@/components/settings/Providers';
import { WatchlistPanel } from '@/components/settings/Watchlist';
import { JsonSetting } from '@/components/settings/JsonSetting';
import { useCrt } from '@/lib/prefs';

export default function SettingsPage() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [crt, setCrtPref] = useCrt();
  const value = (key: string): string | undefined => settings.data?.find((s) => s.key === key)?.value;

  return (
    <div className="space-y-4">
      <PixelTitle className="text-green">SETTINGS</PixelTitle>

      <ProvidersPanel />
      <WatchlistPanel />

      <JsonSetting settingKey="guards.defaults" title="Guard defaults (advanced)" raw={value('guards.defaults')} />
      <JsonSetting
        settingKey="triggers.thresholds"
        title="Trigger thresholds (advanced)"
        raw={value('triggers.thresholds')}
      />

      <Panel title="Display">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={crt === true}
            onChange={(e) => setCrtPref(e.target.checked)}
            className="h-3 w-3 p-0"
          />
          CRT scanline overlay
          <span className="text-[10px] text-muted">(off by default, stored in this browser)</span>
        </label>
      </Panel>
    </div>
  );
}
