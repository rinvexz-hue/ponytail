import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { krakenPaperEngine } from '../krakenEngine'
import type { KrakenPaperState, KrakenStatus } from '../krakenEngine'
import { Sparkline } from './Sparkline'
import { formatPct, formatPrice, formatSigned, formatUsd } from '../lib/format'

const STATUS_META: Record<KrakenStatus, { label: string; color: string; bg: string; border: string }> = {
  live: { label: 'KRAKEN: LIVE', color: 'text-profit', bg: 'bg-profit/10', border: 'border-profit/30' },
  connecting: { label: 'KRAKEN: CONNECTING', color: 'text-amber-soft', bg: 'bg-amber/10', border: 'border-amber/30' },
  degraded: { label: 'KRAKEN: DEGRADED', color: 'text-amber-soft', bg: 'bg-amber/10', border: 'border-amber/30' },
  error: { label: 'KRAKEN: OFFLINE', color: 'text-loss', bg: 'bg-loss/10', border: 'border-loss/30' },
}

export function KrakenPanel() {
  const [state, setState] = useState<KrakenPaperState | null>(null)

  useEffect(() => {
    const stop = krakenPaperEngine.start((snapshot) => setState(snapshot))
    return stop
  }, [])

  if (!state) return null

  const meta = STATUS_META[state.status]
  const totalTrades = state.wins + state.losses
  const totalPnl = state.equity - state.equitySeries[0]
  const totalPnlPct = state.equitySeries[0] > 0 ? (totalPnl / state.equitySeries[0]) * 100 : 0
  const hitRatePct = totalTrades > 0 ? (state.wins / totalTrades) * 100 : 0

  return (
    <section className="px-4 pb-6 sm:px-6">
      <div className="rounded-lg border border-sky-500/30 bg-void-panel p-4 shadow-panel sm:p-6">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-xs font-semibold tracking-widest text-slate-400">KRAKEN PAPER DESK</h2>
          <span
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold ${meta.bg} ${meta.border} ${meta.color}`}
            title={state.statusDetail}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${state.status === 'live' ? 'animate-pulseDot' : ''}`}
              style={{ backgroundColor: 'currentColor' }}
            />
            {meta.label}
          </span>
          <span className="rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-amber-soft">
            PAPER · NO REAL ORDERS
          </span>
        </div>
        <p className="mb-3 font-mono text-[10px] leading-snug text-slate-600">
          Runs the same validated entry/exit/risk rules as the REAL DATA backtest above, driven by Kraken's live public
          ticker (no API key, no wallet, read-only) instead of history. Every fill below is simulated — nothing is ever
          sent to Kraken as an order. A separate, explicit step would be needed before this could ever place a real trade.
        </p>

        {state.assets.length === 0 ? (
          <p className="font-mono text-[10px] text-loss">{state.statusDetail ?? 'No tracked assets resolved on Kraken yet.'}</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {state.assets.map((a) => {
                const price = state.prices[a.label]
                return (
                  <div
                    key={a.label}
                    className="flex items-center gap-1.5 rounded-md border border-void-border bg-void-raised px-2.5 py-1 font-mono text-[10px]"
                  >
                    <span className="font-semibold text-slate-300">{a.label}</span>
                    <span className="text-slate-500">{price !== undefined ? `$${formatPrice(price)}` : 'resolving…'}</span>
                  </div>
                )
              })}
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <Stat label="PAPER EQUITY" value={formatUsd(state.equity)} />
              <Stat
                label="TOTAL P&L"
                value={`${formatSigned(totalPnl)} (${formatPct(totalPnlPct, 1)})`}
                positive={totalPnl >= 0}
              />
              <Stat label="HIT RATE" value={`${hitRatePct.toFixed(1)}% · ${state.wins}W/${state.losses}L`} />
              <Stat label="FILLS" value={state.fills.toLocaleString('en-US')} />
              <Stat label="TICKET CEILING BLOCKS" value={state.ticketCeilingBlocks.toLocaleString('en-US')} />
              <Stat label="KILL-SWITCH BLOCKS" value={state.killSwitchBlocks.toLocaleString('en-US')} positive={state.killSwitchBlocks === 0} />
              <Stat label="POLLS" value={state.polls.toLocaleString('en-US')} />
            </div>

            <div className="mt-3">
              <Sparkline data={state.equitySeries} color={totalPnl >= 0 ? '#22c55e' : '#ef4444'} height={40} />
            </div>

            <div className="mt-4">
              <div className="mb-1.5 font-mono text-[9px] tracking-wide text-slate-600">OPEN PAPER POSITIONS · {state.positions.length}</div>
              <div className="max-h-[180px] overflow-y-auto">
                <AnimatePresence initial={false}>
                  {state.positions.map((p) => {
                    const price = state.prices[p.token] ?? p.entryPrice
                    const unrealizedPnl = (price - p.entryPrice) * p.units
                    const unrealizedPnlPct = (unrealizedPnl / p.notional) * 100
                    const up = unrealizedPnl >= 0
                    return (
                      <motion.div
                        key={p.id}
                        layout
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.22 }}
                        className="flex flex-wrap items-center justify-between gap-2 border-b border-void-border/60 py-1.5 font-mono text-[10px]"
                      >
                        <span className="font-semibold text-slate-200">{p.token}</span>
                        <span className="text-slate-500">
                          entry {formatPrice(p.entryPrice)} → mark {formatPrice(price)}
                        </span>
                        <span className={up ? 'text-profit' : 'text-loss'}>
                          {formatSigned(unrealizedPnl)} ({formatPct(unrealizedPnlPct, 1)})
                        </span>
                      </motion.div>
                    )
                  })}
                </AnimatePresence>
                {state.positions.length === 0 && (
                  <div className="py-3 text-center font-mono text-[10px] text-slate-600">no open paper positions — waiting for an entry signal</div>
                )}
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-1.5 font-mono text-[9px] tracking-wide text-slate-600">PAPER TRADE LOG</div>
              <div className="max-h-[160px] overflow-y-auto">
                <AnimatePresence initial={false}>
                  {state.log.map((entry) => (
                    <motion.div
                      key={entry.id}
                      layout
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.22 }}
                      className="flex flex-wrap items-center gap-2 border-b border-void-border/60 py-1.5 font-mono text-[10px]"
                    >
                      <span
                        className={
                          'shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold ' +
                          (entry.action === 'BUY' ? 'border-profit/30 bg-profit/10 text-profit' : 'border-amber/30 bg-amber/10 text-amber-soft')
                        }
                      >
                        {entry.action}
                      </span>
                      <span className="font-semibold text-slate-300">{entry.token}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-500">{entry.reason}</span>
                      {entry.pnl !== null && (
                        <span className={entry.pnl >= 0 ? 'font-semibold text-profit' : 'font-semibold text-loss'}>{formatSigned(entry.pnl)}</span>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
                {state.log.length === 0 && <div className="py-3 text-center font-mono text-[10px] text-slate-600">awaiting first paper fill…</div>}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function Stat({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="flex min-w-[120px] flex-col gap-0.5">
      <span className="font-mono text-[9px] tracking-wider text-slate-600">{label}</span>
      <span className={'font-mono text-sm font-bold ' + (positive === undefined ? 'text-slate-100' : positive ? 'text-profit' : 'text-loss')}>
        {value}
      </span>
    </div>
  )
}
