import { ApiKeysCard } from '@/components/settings/ApiKeysCard';
import { WatchlistManager } from '@/components/settings/WatchlistManager';

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <h1 className="pixel-font text-neon-cyan glow text-xs">SETTINGS</h1>
      <section>
        <h2 className="pixel-font text-neon-amber text-[10px] mb-4">API KEYS</h2>
        <ApiKeysCard />
      </section>
      <section>
        <h2 className="pixel-font text-neon-amber text-[10px] mb-4">WATCHLISTS</h2>
        <WatchlistManager />
      </section>
    </div>
  );
}
