import { useSwarmStore } from '../store'
import { formatPct, formatPrice } from '../lib/format'

export function TickerBar() {
  const tickers = useSwarmStore((s) => s.tickers)
  const loop = [...tickers, ...tickers]

  return (
    <div className="w-full overflow-hidden border-b border-void-border bg-void-panel/80">
      <div className="flex w-max animate-[scroll_38s_linear_infinite] gap-0 py-1.5 hover:[animation-play-state:paused]">
        {loop.map((t, idx) =>
          t.hasRealData ? (
            <div
              key={`${t.symbol}-${idx}`}
              className="flex items-center gap-2 whitespace-nowrap border-r border-void-border/60 px-4 font-mono text-xs"
            >
              <span className="font-semibold text-slate-300">{t.symbol}</span>
              <span className="text-slate-500">${formatPrice(t.price)}</span>
              <span
                className={
                  'flex items-center gap-0.5 font-semibold ' +
                  (t.direction > 0 ? 'text-profit' : 'text-loss')
                }
              >
                {t.direction > 0 ? '▲' : '▼'}
                {formatPct(t.changePct, 1)}
              </span>
            </div>
          ) : (
            <div
              key={`${t.symbol}-${idx}`}
              className="flex items-center gap-2 whitespace-nowrap border-r border-void-border/60 px-4 font-mono text-xs"
            >
              <span className="font-semibold text-slate-500">{t.symbol}</span>
              <span className="text-slate-600">resolving…</span>
            </div>
          ),
        )}
      </div>
      <style>{`
        @keyframes scroll {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  )
}
