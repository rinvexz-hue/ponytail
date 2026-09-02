import { AnimatePresence, motion } from 'framer-motion'
import { useSwarmStore } from '../store'
import { AGENT_META } from '../lib/agents'
import { formatSigned } from '../lib/format'
import type { ActionType } from '../types'

const ACTION_STYLES: Record<ActionType, string> = {
  BUY: 'bg-profit/10 text-profit border-profit/30',
  SELL: 'bg-amber/10 text-amber-soft border-amber/30',
  ROUTE: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  FILL: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  QUOTE: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  HEDGE: 'bg-loss/10 text-loss border-loss/30',
}

export function ActivityLog() {
  const log = useSwarmStore((s) => s.log)
  const resolvedCount = useSwarmStore((s) => s.resolvedCount)
  const alphaRadarConnected = useSwarmStore((s) => s.alphaRadarConnected)

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto pr-1" style={{ maxHeight: 340 }}>
        <AnimatePresence initial={false}>
          {log.map((entry) => {
            const meta = AGENT_META[entry.agentId]
            return (
              <motion.div
                key={entry.id}
                layout
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="flex items-center gap-2.5 border-b border-void-border/60 py-2 font-mono text-xs"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: meta.color, boxShadow: `0 0 6px 1px ${meta.glow}` }}
                />
                <span className="w-[92px] shrink-0 truncate text-[10px] font-semibold tracking-wide text-slate-400">
                  {meta.name}
                </span>
                <span
                  className={
                    'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' +
                    ACTION_STYLES[entry.action]
                  }
                >
                  {entry.action}
                </span>
                <span className="w-12 shrink-0 font-semibold text-slate-300">{entry.token}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500">{entry.reason}</span>
                {entry.pnl !== null && (
                  <span
                    className={
                      'shrink-0 font-semibold ' + (entry.pnl >= 0 ? 'text-profit' : 'text-loss')
                    }
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatSigned(entry.pnl)}
                  </span>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
        {log.length === 0 && (
          <div className="py-8 text-center font-mono text-xs text-slate-600">awaiting first fill…</div>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-void-border pt-2 font-mono text-[10px] tracking-wide text-slate-600">
        <span>{resolvedCount.toLocaleString()} resolved</span>
        {alphaRadarConnected && (
          <span className="flex items-center gap-1 text-profit">
            <span className="h-1.5 w-1.5 rounded-full bg-profit" style={{ boxShadow: '0 0 4px 1px currentColor' }} />
            LIVE · AlphaRadar
          </span>
        )}
      </div>
    </div>
  )
}
