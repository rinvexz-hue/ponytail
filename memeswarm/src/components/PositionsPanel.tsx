import { AnimatePresence, motion } from 'framer-motion'
import { useSwarmStore } from '../store'
import { AnimatedNumber } from './AnimatedNumber'
import { formatPct, formatPrice, formatSigned, formatUsd } from '../lib/format'
import type { Position } from '../types'

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

      <div className="max-h-[240px] overflow-y-auto">
        <AnimatePresence initial={false}>
          {positions.map((p) => (
            <PositionRow key={p.id} p={p} />
          ))}
        </AnimatePresence>
        {positions.length === 0 && (
          <div className="py-6 text-center font-mono text-xs text-slate-600">no open positions — SNIPER is scanning for entries</div>
        )}
      </div>
    </section>
  )
}

function PositionRow({ p }: { p: Position }) {
  const up = p.unrealizedPnl >= 0
  const pnlColor = up ? 'text-profit' : 'text-loss'

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className="border-b border-void-border/60 py-2 font-mono text-xs"
    >
      {/* mobile: compact two-line card */}
      <div className="flex flex-col gap-1 sm:hidden">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-semibold text-slate-200">
            <span className={pnlColor}>{up ? '▲' : '▼'}</span>
            {p.token}
          </span>
          <span className={'font-semibold ' + pnlColor}>
            <AnimatedNumber value={p.unrealizedPnl} format={(v) => formatSigned(v)} />{' '}
            <span className="text-[10px] opacity-80">({formatPct(p.unrealizedPnlPct, 1)})</span>
          </span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>
            entry {formatPrice(p.entryPrice)} → mark{' '}
            <span className="text-slate-300">
              <AnimatedNumber value={p.currentPrice} format={(v) => formatPrice(v)} />
            </span>
          </span>
          <span>{formatUsd(p.notional, { compact: true })}</span>
        </div>
      </div>

      {/* desktop: aligned columns */}
      <div className="hidden items-center gap-2 sm:grid sm:grid-cols-[1fr_1fr_1fr_1fr_1.2fr]">
        <span className="flex items-center gap-1.5 font-semibold text-slate-200">
          <span className={pnlColor}>{up ? '▲' : '▼'}</span>
          {p.token}
        </span>
        <span className="text-right text-slate-500">{formatPrice(p.entryPrice)}</span>
        <span className="text-right text-slate-300">
          <AnimatedNumber value={p.currentPrice} format={(v) => formatPrice(v)} />
        </span>
        <span className="text-right text-slate-500">{formatUsd(p.notional, { compact: true })}</span>
        <span className={'text-right font-semibold ' + pnlColor}>
          <AnimatedNumber value={p.unrealizedPnl} format={(v) => formatSigned(v)} />{' '}
          <span className="text-[10px] opacity-80">({formatPct(p.unrealizedPnlPct, 1)})</span>
        </span>
      </div>
    </motion.div>
  )
}
