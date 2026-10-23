/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './public/**/*.{html,js}',
  ],
  safelist: [
    'status-todo', 'status-planning', 'status-implement', 'status-testing', 'status-verify', 'status-fixing', 'status-pending', 'status-done', 'status-cancelled', 'status-failed', 'status-archived',
    'text-amber-400', 'text-amber-300', 'text-emerald-400', 'text-rose-400', 'text-sky-400', 'text-slate-300', 'text-slate-400', 'text-slate-500', 'text-indigo-300', 'text-brand-300',
    'bg-amber-500/10', 'bg-amber-500/20', 'bg-amber-500/30', 'bg-amber-500/40', 'bg-amber-500/5', 'bg-amber-900/40',
    'bg-emerald-500/10', 'bg-emerald-500/20', 'bg-emerald-500/30',
    'bg-rose-500/10', 'bg-rose-500/20', 'bg-rose-500/30', 'bg-rose-500/5',
    'bg-slate-500/10', 'bg-slate-700', 'bg-slate-800', 'bg-slate-800/60', 'bg-slate-900/80',
    'border-amber-500/25', 'border-amber-500/30', 'border-amber-500/40',
    'border-brand-500/25',
    'border-emerald-500/30',
    'border-rose-500/30',
    'border-slate-800', 'border-slate-600/30', 'border-slate-700',
    'evidence-pass', 'evidence-fail', 'evidence-badge',
    'active',
    'hidden',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
        },
        surface: {
          800: '#1e293b',
          850: '#162032',
          900: '#0f172a',
          950: '#080d1a',
        }
      },
      animation: {
        'pulse-fast': 'pulse 1.2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(56, 189, 248, 0.3)' },
          '100%': { boxShadow: '0 0 18px rgba(56, 189, 248, 0.8)' },
        }
      }
    }
  },
  plugins: [],
};
