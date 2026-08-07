import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Wick',
  description: 'Wick — LLM paper-trading bots on live crypto data',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg text-fg">
        {/* Phase 6 rebuilds the shell (navbar, pages, design system). */}
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
