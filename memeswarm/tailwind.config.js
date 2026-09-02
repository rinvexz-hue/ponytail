/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        void: {
          DEFAULT: '#0a0a0f',
          panel: '#101018',
          raised: '#15151f',
          border: '#23232f',
        },
        profit: {
          DEFAULT: '#22c55e',
          dim: '#16a34a',
          glow: 'rgba(34,197,94,0.35)',
        },
        loss: {
          DEFAULT: '#ef4444',
          dim: '#dc2626',
          glow: 'rgba(239,68,68,0.35)',
        },
        amber: {
          DEFAULT: '#f59e0b',
          soft: '#fbbf24',
          glow: 'rgba(245,158,11,0.35)',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'inner-glow': 'inset 0 0 60px 0 rgba(245,158,11,0.08)',
        'panel': '0 0 0 1px rgba(255,255,255,0.03), 0 8px 24px -8px rgba(0,0,0,0.5)',
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: 1, transform: 'scale(1)' },
          '50%': { opacity: 0.55, transform: 'scale(0.85)' },
        },
        slideInTop: {
          '0%': { opacity: 0, transform: 'translateY(-10px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        scan: {
          '0%': { backgroundPosition: '0% 0%' },
          '100%': { backgroundPosition: '200% 0%' },
        },
      },
      animation: {
        pulseDot: 'pulseDot 1.6s ease-in-out infinite',
        slideInTop: 'slideInTop 0.35s ease-out',
        scan: 'scan 3s linear infinite',
      },
    },
  },
  plugins: [],
}
