import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Wick palette (PLAN §12) — mapped to the CSS variables in globals.css
        bg: 'var(--bg)',
        panel: 'var(--panel)',
        line: 'var(--border)',
        green: 'var(--green)',
        amber: 'var(--amber)',
        cyan: 'var(--cyan)',
        red: 'var(--red)',
        fg: 'var(--fg)',
        muted: 'var(--muted)',
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', 'monospace'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      borderRadius: { none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0' },
    },
  },
  plugins: [],
};

export default config;
