import type { Metadata } from 'next';
import './globals.css';
import { Scanlines } from '@/components/shell/Scanlines';
import { Navbar } from '@/components/shell/Navbar';
import { NotificationsBridge } from '@/components/shell/NotificationsBridge';
import { QueryProvider } from '@/lib/query';

export const metadata: Metadata = {
  title: 'Cockpit',
  description: 'Trading Cockpit',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg-void text-text-primary">
        <QueryProvider>
          <Scanlines />
          <Navbar />
          <NotificationsBridge />
          <main className="pt-14 p-4">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
