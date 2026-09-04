import { useState } from 'react'
import { runBacktest, runBacktestOnRealCandles } from '../backtest'
import type { BacktestResult } from '../backtest'
import { fetchHistoricalCloses, GRANULARITY_OPTIONS, REAL_DATA_ASSETS } from '../lib/historicalData'
import type { Granularity } from '../lib/historicalData'
import { Sparkline } from './Sparkline'
import { formatPct, formatSigned, formatUsd } from '../lib/format'

const PRESETS = [
  { label: '1H', hours: 1 },
  { label: '24H', hours: 24 },
  { label: '7D', hours: 24 * 7 },
  { label: '30D', hours: 24 * 30 },
]

const DAY_PRESETS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 365 * 3 },
]

export function BacktestPanel() {
  const [mode, setMode] = useState<'synthetic' | 'real'>('synthetic')
  const [hoursInput, setHoursInput] = useState('168')
  const [daysInput, setDaysInput] = useState('365')
  const [symbol, setSymbol] = useState(REAL_DATA_ASSETS[0].pair)
  const [granularity, setGranularity] = useState<Granularity>('auto')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [history, setHistory] = useState<BacktestResult[]>([])

  const run = () => {
    if (mode === 'synthetic') {
      const hours = Number(hoursInput)
      if (!Number.isFinite(hours) || hours <= 0) return
      setError(null)
      setRunning(true)
      // Let React paint the "RUNNING…" state before the computation (still
      // synchronous, just fast) runs on the main thread.
      setTimeout(() => {
        const res = runBacktest(hours)
        setResult(res)
        setHistory((prev) => [res, ...prev].slice(0, 5))
        setRunning(false)
      }, 30)
      return
    }

    const days = Number(daysInput)
    if (!Number.isFinite(days) || days <= 0) return
    setError(null)
    setRunning(true)
    const asset = REAL_DATA_ASSETS.find((a) => a.pair === symbol) ?? REAL_DATA_ASSETS[0]
    fetchHistoricalCloses(asset.pair, days, granularity)
      .then(({ candles, msPerCandle }) => {
        const res = runBacktestOnRealCandles(candles, msPerCandle, asset.label)
        setResult(res)
        setHistory((prev) => [res, ...prev].slice(0, 5))
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to fetch real historical data')
      })
      .finally(() => setRunning(false))
  }

  return (
    <section className="px-4 pb-6 sm:px-6">
      <div className="rounded-lg border border-void-border bg-void-panel p-4 shadow-panel sm:p-6">
        <h2 className="mb-1 font-mono text-xs font-semibold tracking-widest text-slate-400">BACKTEST</h2>
        <p className="mb-3 font-mono text-[10px] leading-snug text-slate-600">
          {mode === 'synthetic' ? (
            <>
              Runs the same entry/exit rules against fresh synthetic price action, instantly fast-forwarded to
              whatever duration you set — fully isolated from your live session, it never touches it. Regenerated
              from scratch on every run, so results vary — that's the point (Monte Carlo, not one fixed answer).
            </>
          ) : (
            <>
              Runs the same rules against real historical closes pulled live from Binance's public API (any asset
              it lists, not just meme coins) — fully isolated from your live session. Only the PRICE series is
              real: there's no historical feed for SCOUT/SENTIMENT/WHALE-WATCH's actual signals, so those are
              approximated from the real price momentum itself. Treat this as validating the entry/exit/risk
              rules against real history, not a replay of the full agent logic.
            </>
          )}
        </p>

        <div className="mb-3 flex gap-1.5">
          {(['synthetic', 'real'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m)
                setError(null)
              }}
              className={
                'rounded-md border px-2.5 py-1 font-mono text-[10px] font-bold tracking-wide transition ' +
                (mode === m
                  ? 'border-amber/50 bg-amber/10 text-amber-soft'
                  : 'border-void-border bg-void-raised text-slate-400 hover:border-slate-600')
              }
            >
              {m === 'synthetic' ? 'SYNTHETIC' : 'REAL DATA'}
            </button>
          ))}
        </div>

        {mode === 'synthetic' ? (
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setHoursInput(String(p.hours))}
                className={
                  'rounded-md border px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide transition ' +
                  (hoursInput === String(p.hours)
                    ? 'border-amber/50 bg-amber/10 text-amber-soft'
                    : 'border-void-border bg-void-raised text-slate-400 hover:border-slate-600')
                }
              >
                {p.label}
              </button>
            ))}
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={8760}
                value={hoursInput}
                onChange={(e) => setHoursInput(e.target.value)}
                className="w-20 rounded-md border border-void-border bg-void-raised px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-amber/50"
              />
              <span className="font-mono text-[10px] text-slate-600">hours</span>
            </div>
            <button
              onClick={run}
              disabled={running}
              className="rounded-md border border-amber/40 bg-amber/10 px-3 py-1 font-mono text-[10px] font-bold tracking-wide text-amber-soft transition hover:bg-amber/20 disabled:opacity-50"
            >
              {running ? 'RUNNING…' : 'RUN BACKTEST'}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="rounded-md border border-void-border bg-void-raised px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-amber/50"
            >
              {REAL_DATA_ASSETS.map((a) => (
                <option key={a.pair} value={a.pair}>
                  {a.label}
                </option>
              ))}
            </select>
            {DAY_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setDaysInput(String(p.days))}
                className={
                  'rounded-md border px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide transition ' +
                  (daysInput === String(p.days)
                    ? 'border-amber/50 bg-amber/10 text-amber-soft'
                    : 'border-void-border bg-void-raised text-slate-400 hover:border-slate-600')
                }
              >
                {p.label}
              </button>
            ))}
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={1500}
                value={daysInput}
                onChange={(e) => setDaysInput(e.target.value)}
                className="w-20 rounded-md border border-void-border bg-void-raised px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-amber/50"
              />
              <span className="font-mono text-[10px] text-slate-600">days</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] text-slate-600">candles</span>
              <select
                value={granularity}
                onChange={(e) => setGranularity(e.target.value as Granularity)}
                className="rounded-md border border-void-border bg-void-raised px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-amber/50"
              >
                {GRANULARITY_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {g === 'auto' ? 'AUTO' : g}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={run}
              disabled={running}
              className="rounded-md border border-amber/40 bg-amber/10 px-3 py-1 font-mono text-[10px] font-bold tracking-wide text-amber-soft transition hover:bg-amber/20 disabled:opacity-50"
            >
              {running ? 'FETCHING…' : 'RUN BACKTEST'}
            </button>
          </div>
        )}

        {error && (
          <p className="mt-2 font-mono text-[10px] text-loss">
            {error} — Binance may not list this pair, or the request was blocked (network/CORS/rate-limit).
          </p>
        )}

        {result && (
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-1.5">
              <span
                className={
                  'rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider ' +
                  (result.source === 'real'
                    ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                    : 'border-void-border bg-void-raised text-slate-500')
                }
              >
                {result.source === 'real' ? `REAL · ${result.symbol}` : 'SYNTHETIC'}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <Stat label="END EQUITY" value={formatUsd(result.endEquity)} />
              <Stat
                label="TOTAL P&L"
                value={`${formatSigned(result.totalPnl)} (${formatPct(result.totalPnlPct, 1)})`}
                positive={result.totalPnl >= 0}
              />
              <Stat label="HIT RATE" value={`${result.hitRatePct.toFixed(1)}% · ${result.wins}W/${result.losses}L`} />
              <Stat label="SHARPE" value={result.sharpe.toFixed(2)} />
              <Stat label="MAX DRAWDOWN" value={`${result.maxDrawdownPct.toFixed(1)}%`} />
              <Stat label="BEST / WORST TRADE" value={`${formatSigned(result.bestTradePnl)} / ${formatSigned(result.worstTradePnl)}`} />
              <Stat label="FILLS" value={result.fills.toLocaleString()} />
              <Stat label="TICKET CEILING BLOCKS" value={result.ticketCeilingBlocks.toLocaleString()} />
              <Stat label="KILL-SWITCH BLOCKS" value={result.killSwitchBlocks.toLocaleString()} positive={result.killSwitchBlocks === 0} />
            </div>
            <div className="mt-3">
              <Sparkline data={result.equityCurve} color={result.totalPnl >= 0 ? '#22c55e' : '#ef4444'} height={40} />
            </div>
            <p className="mt-1 font-mono text-[9px] text-slate-600">
              {result.ticks.toLocaleString()} decision ticks over {result.virtualHours.toLocaleString()}h simulated
            </p>
          </div>
        )}

        {history.length > 1 && (
          <div className="mt-4 border-t border-void-border pt-3">
            <div className="mb-1.5 font-mono text-[9px] tracking-wide text-slate-600">RECENT RUNS</div>
            <div className="space-y-1">
              {history.map((h, i) => (
                <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[10px] text-slate-500">
                  <span className="w-16 text-slate-400">{h.source === 'real' ? h.symbol : 'synth'}</span>
                  <span className="w-14 text-slate-400">{h.virtualHours.toLocaleString()}h</span>
                  <span className={h.totalPnl >= 0 ? 'text-profit' : 'text-loss'}>{formatPct(h.totalPnlPct, 1)}</span>
                  <span>{h.hitRatePct.toFixed(0)}% hit</span>
                  <span>sharpe {h.sharpe.toFixed(2)}</span>
                  <span>dd {h.maxDrawdownPct.toFixed(1)}%</span>
                  <span>{h.fills.toLocaleString()} fills</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function Stat({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="flex min-w-[120px] flex-col gap-0.5">
      <span className="font-mono text-[9px] tracking-wider text-slate-600">{label}</span>
      <span
        className={
          'font-mono text-sm font-bold ' +
          (positive === undefined ? 'text-slate-100' : positive ? 'text-profit' : 'text-loss')
        }
      >
        {value}
      </span>
    </div>
  )
}
