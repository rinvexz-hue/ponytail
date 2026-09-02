import { useSwarmStore } from '../store'
import { AnimatedNumber } from './AnimatedNumber'
import { Sparkline } from './Sparkline'
import { formatPct, formatSigned, formatUsd } from '../lib/format'

function KpiCard({
  label,
  children,
  sub,
}: {
  label: string
  children: React.ReactNode
  sub?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 basis-[calc(50%-0.5rem)] flex-col gap-1 rounded-lg border border-void-border bg-void-panel p-4 shadow-panel sm:basis-[calc(25%-0.75rem)]">
      <span className="font-mono text-[10px] font-semibold tracking-widest text-slate-500">{label}</span>
      {children}
      {sub}
    </div>
  )
}

export function KpiRow() {
  const kpis = useSwarmStore((s) => s.kpis)

  const pnlColor = kpis.totalPnl >= 0 ? '#22c55e' : '#ef4444'

  return (
    <div className="flex flex-wrap gap-3 px-4 py-4 sm:px-6">
      <KpiCard label="NET EQUITY">
        <AnimatedNumber
          value={kpis.netEquity}
          format={(v) => formatUsd(v)}
          className="font-mono text-2xl font-bold text-slate-100"
        />
        <span className="font-mono text-[10px] text-slate-600">seed {formatUsd(kpis.seedEquity, { compact: true })}</span>
        <Sparkline data={kpis.netEquitySeries} color="#f59e0b" />
      </KpiCard>

      <KpiCard label="TOTAL P&amp;L">
        <div className="flex items-baseline gap-2">
          <AnimatedNumber
            value={kpis.totalPnl}
            format={(v) => formatSigned(v)}
            className={'font-mono text-2xl font-bold ' + (kpis.totalPnl >= 0 ? 'text-profit' : 'text-loss')}
          />
          <AnimatedNumber
            value={kpis.totalPnlPct}
            format={(v) => formatPct(v, 1)}
            className={'font-mono text-xs font-semibold ' + (kpis.totalPnl >= 0 ? 'text-profit' : 'text-loss')}
          />
        </div>
        <Sparkline data={kpis.pnlSeries} color={pnlColor} />
      </KpiCard>

      <KpiCard
        label="24H VOLUME"
        sub={
          <span className="font-mono text-[10px] text-slate-600">
            {kpis.fills.toLocaleString()} fills · {kpis.venues} venues
          </span>
        }
      >
        <AnimatedNumber
          value={kpis.volume24h}
          format={(v) => formatUsd(v, { compact: true })}
          className="font-mono text-2xl font-bold text-slate-100"
        />
      </KpiCard>

      <KpiCard
        label="HIT RATE"
        sub={
          <span className="font-mono text-[10px] text-slate-600">
            {kpis.wins}W / {kpis.losses}L · sharpe {kpis.sharpe.toFixed(2)}
          </span>
        }
      >
        <AnimatedNumber
          value={kpis.hitRatePct}
          format={(v) => `${v.toFixed(1)}%`}
          className="font-mono text-2xl font-bold text-slate-100"
        />
        <Sparkline data={kpis.hitRateSeries} color="#38bdf8" />
      </KpiCard>
    </div>
  )
}
