import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/Nav';
import { CrtOverlay } from '@/components/CrtOverlay';
import { QueryProvider } from '@/lib/query';

export const metadata: Metadata = {
  title: 'Wick',
  description: 'Wick — LLM paper-trading bots on live crypto data',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg text-fg">
        <QueryProvider>
          <Nav />
          <main className="p-4">{children}</main>
          <CrtOverlay />
        </QueryProvider>
      </body>
    </html>
  );
}
