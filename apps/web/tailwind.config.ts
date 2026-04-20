import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'bg-void': 'var(--bg-void)',
        'bg-terminal': 'var(--bg-terminal)',
        'bg-elevated': 'var(--bg-elevated)',
        'border-dim': 'var(--border-dim)',
        'neon-cyan': 'var(--neon-cyan)',
        'neon-magenta': 'var(--neon-magenta)',
        'neon-green': 'var(--neon-green)',
        'neon-red': 'var(--neon-red)',
        'neon-amber': 'var(--neon-amber)',
        'neon-purple': 'var(--neon-purple)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-dim': '#8a8ab8',
      },
      fontFamily: {
        'pixel': ['"Press Start 2P"', 'monospace'],
        'mono-pixel': ['VT323', 'monospace'],
        'sans-pixel': ['"Pixelify Sans"', 'sans-serif'],
      },
      borderRadius: { 'none': '0', 'sm': '0', DEFAULT: '0', 'md': '0', 'lg': '0', 'xl': '0' },
    },
  },
  plugins: [],
};

export default config;
