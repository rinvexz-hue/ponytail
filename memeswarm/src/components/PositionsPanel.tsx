import { AnimatePresence, motion } from 'framer-motion'
import { useSwarmStore } from '../store'
import { AnimatedNumber } from './AnimatedNumber'
import { formatPct, formatPrice, formatSigned, formatUsd } from '../lib/format'

export function PositionsPanel() {
  const positions = useSwarmStore((s) => s.positions)

  return (
    <section className="mx-4 mb-4 rounded-lg border border-void-border bg-void-panel p-4 shadow-panel sm:mx-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-mono text-xs font-semibold tracking-widest text-slate-400">OPEN POSITIONS</h2>
        <span className="font-mono text-[10px] tracking-wide text-slate-600">{positions.length} open</span>
      </div>

      {positions.length > 0 && (
        <div className="hidden grid-cols-[1fr_1fr_1fr_1fr_1.2fr] gap-2 border-b border-void-border/60 pb-1.5 font-mono text-[10px] tracking-wide text-slate-600 sm:grid">
          <span>TOKEN</span>
          <span className="text-right">ENTRY</span>
          <span className="text-right">MARK</span>
          <span className="text-right">SIZE</span>
          <span className="text-right">UNREALIZED P&amp;L</span>
        </div>
      )}

      <div className="max-h-[220px] overflow-y-auto">
        <AnimatePresence initial={false}>
          {positions.map((p) => {
            const up = p.unrealizedPnl >= 0
            return (
              <motion.div
                key={p.id}
                layout
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="grid grid-cols-2 items-center gap-y-1 border-b border-void-border/60 py-2 font-mono text-xs sm:grid-cols-[1fr_1fr_1fr_1fr_1.2fr] sm:gap-2"
              >
                <span className="flex items-center gap-1.5 font-semibold text-slate-200">
                  <span className={up ? 'text-profit' : 'text-loss'}>{up ? '▲' : '▼'}</span>
                  {p.token}
                </span>
                <span className="text-right text-slate-500 sm:text-right">{formatPrice(p.entryPrice)}</span>
                <span className="text-right text-slate-300">
                  <AnimatedNumber value={p.currentPrice} format={(v) => formatPrice(v)} />
                </span>
                <span className="col-span-2 text-right text-slate-500 sm:col-span-1">
                  {formatUsd(p.notional, { compact: true })}
                </span>
                <span className={'col-span-2 text-right font-semibold sm:col-span-1 ' + (up ? 'text-profit' : 'text-loss')}>
                  <AnimatedNumber value={p.unrealizedPnl} format={(v) => formatSigned(v)} />{' '}
                  <span className="text-[10px] opacity-80">({formatPct(p.unrealizedPnlPct, 1)})</span>
                </span>
              </motion.div>
            )
          })}
        </AnimatePresence>
        {positions.length === 0 && (
          <div className="py-6 text-center font-mono text-xs text-slate-600">no open positions — SNIPER is scanning for entries</div>
        )}
      </div>
    </section>
  )
}
