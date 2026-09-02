import { useSwarmStore } from '../store'
import { BalanceChart } from './BalanceChart'
import { ActivityLog } from './ActivityLog'
import { formatUsd } from '../lib/format'

export function TradingPanel() {
  const netEquity = useSwarmStore((s) => s.kpis.netEquity)

  return (
    <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:px-6 lg:grid-cols-2">
      <section className="rounded-lg border border-void-border bg-void-panel p-4 shadow-panel">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-xs font-semibold tracking-widest text-slate-400">BALANCE HISTORY · 24H</h2>
          <span className="font-mono text-xs font-bold text-slate-200">{formatUsd(netEquity)}</span>
        </div>
        <BalanceChart />
      </section>

      <section className="rounded-lg border border-void-border bg-void-panel p-4 shadow-panel">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-mono text-xs font-semibold tracking-widest text-slate-400">ACTIVITY LOG</h2>
        </div>
        <ActivityLog />
      </section>
    </div>
  )
}
