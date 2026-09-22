import { useEffect, useState } from 'react'
import { runBacktestOnRealBasket, runBacktestOnRealCandles } from '../backtest'
import type { BacktestResult, RealBasketAsset } from '../backtest'
import { fetchHistoricalCloses, GRANULARITY_OPTIONS, REAL_DATA_ASSETS } from '../lib/historicalData'
import type { Granularity } from '../lib/historicalData'
import { discoverKrakenAssets, fetchKrakenOHLC } from '../lib/krakenData'
import type { KrakenAsset, KrakenGranularity } from '../lib/krakenData'
import { TICKER_SYMBOLS } from '../lib/agents'
import { Sparkline } from './Sparkline'
import { formatPct, formatSigned, formatUsd } from '../lib/format'

// The live meme-coin roster, restricted to whatever Binance actually lists
// with public history (MEW/BRETT/TURBO aren't listed anywhere with a public
// historical-candles API — Dexscreener's public API has no history endpoint
// either, only live snapshots, same as marketData.ts already relies on).
const BASKET_ASSETS = REAL_DATA_ASSETS.filter((a) => TICKER_SYMBOLS.includes(a.label))

const DAY_PRESETS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 365 * 3 },
]

const KRAKEN_GRANULARITY_OPTIONS: KrakenGranularity[] = ['5m', '15m', '1h', '4h', '1d']

export function BacktestPanel() {
  const [mode, setMode] = useState<'basket' | 'real'>('basket')
  const [source, setSource] = useState<'binance' | 'kraken'>('binance')
  const [daysInput, setDaysInput] = useState('365')
  const [symbol, setSymbol] = useState(REAL_DATA_ASSETS[0].pair)
  const [granularity, setGranularity] = useState<Granularity>('auto')
  const [krakenAssets, setKrakenAssets] = useState<KrakenAsset[] | null>(null)
  const [krakenSymbol, setKrakenSymbol] = useState<string | null>(null)
  const [krakenGranularity, setKrakenGranularity] = useState<KrakenGranularity>('4h')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [history, setHistory] = useState<BacktestResult[]>([])

  // Kraken's tradable pair list isn't known until we ask it — several roster
  // tickers (BRETT, MEW, TURBO, FLOKI, POPCAT) are Solana/Base-native and
  // simply aren't listed there, so this discovers what actually exists
  // instead of assuming the Binance roster carries over.
  useEffect(() => {
    if (source !== 'kraken' || krakenAssets !== null) return
    discoverKrakenAssets()
      .then((assets) => {
        setKrakenAssets(assets)
        if (assets.length > 0) setKrakenSymbol((prev) => prev ?? assets[0].label)
      })
      .catch((e: unknown) => {
        setKrakenAssets([])
        setError(e instanceof Error ? e.message : 'Failed to load Kraken asset list')
      })
  }, [source, krakenAssets])

  const run = () => {
    if (mode === 'basket') {
      const days = Number(daysInput)
      if (!Number.isFinite(days) || days <= 0) return
      setError(null)
      setRunning(true)
      Promise.allSettled(BASKET_ASSETS.map((a) => fetchHistoricalCloses(a.pair, days, granularity)))
        .then((results) => {
          const assets: RealBasketAsset[] = []
          let msPerCandle = 0
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
              assets.push({ label: BASKET_ASSETS[i].label, candles: r.value.candles })
              msPerCandle = r.value.msPerCandle
            }
          })
          if (assets.length === 0) throw new Error('No basket assets resolved — Binance may be unreachable')
          const res = runBacktestOnRealBasket(assets, msPerCandle)
          setResult(res)
          setHistory((prev) => [res, ...prev].slice(0, 5))
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : 'Failed to fetch basket historical data')
        })
        .finally(() => setRunning(false))
      return
    }

    const days = Number(daysInput)
    if (!Number.isFinite(days) || days <= 0) return
    setError(null)
    setRunning(true)

    if (source === 'kraken') {
      const asset = krakenAssets?.find((a) => a.label === krakenSymbol)
      if (!asset) {
        setError('No Kraken asset selected')
        setRunning(false)
        return
      }
      fetchKrakenOHLC(asset.pairKey, krakenGranularity, days)
        .then(({ candles, msPerCandle }) => {
          const res = runBacktestOnRealCandles(candles, msPerCandle, asset.label)
          setResult(res)
          setHistory((prev) => [res, ...prev].slice(0, 5))
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : 'Failed to fetch Kraken historical data')
        })
        .finally(() => setRunning(false))
      return
    }

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
          {mode === 'basket' ? (
            <>
              Runs the EXACT live rule set (fixed 5% stop / 10% trail-arm / 2.5x moonshot cap, unbiased entry pick
              across several assets at once) against real historical closes for the meme coins Binance actually
              lists ({BASKET_ASSETS.map((a) => a.label).join('/')} — MEW/BRETT/TURBO aren't on Binance, and
              Dexscreener's public API has no historical-candles endpoint at all, only live snapshots). Only the
              PRICE series is real; SCOUT/SENTIMENT/WHALE-WATCH are approximated from real price momentum. This is
              the mode that validates what's actually trading live — ATR RULES below tests a different,
              volatility-scaled rule set calibrated for majors like BTC.
            </>
          ) : (
            <>
              Runs a volatility-scaled (ATR-style) rule set — sized off each asset's own observed volatility rather
              than a fixed %, calibrated for majors — against real historical closes pulled live from Binance's or
              Kraken's public API, one asset at a time. Only the PRICE series is real; SCOUT/SENTIMENT/WHALE-WATCH
              are approximated from real price momentum. This is NOT the rule set the live meme-coin dashboard
              trades with — see LIVE RULES above for that.
            </>
          )}
        </p>

        <div className="mb-3 flex gap-1.5">
          {(['basket', 'real'] as const).map((m) => (
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
              {m === 'basket' ? 'LIVE RULES · REAL' : 'ATR RULES · REAL'}
            </button>
          ))}
        </div>

        {mode === 'basket' ? (
          <div className="flex flex-wrap items-center gap-2">
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
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex gap-1.5">
              {(['binance', 'kraken'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setSource(s)
                    setError(null)
                  }}
                  className={
                    'rounded-md border px-2.5 py-1 font-mono text-[10px] font-bold tracking-wide transition ' +
                    (source === s
                      ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                      : 'border-void-border bg-void-raised text-slate-400 hover:border-slate-600')
                  }
                >
                  {s === 'binance' ? 'BINANCE' : 'KRAKEN'}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {source === 'binance' ? (
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
              ) : (
                <select
                  value={krakenSymbol ?? ''}
                  onChange={(e) => setKrakenSymbol(e.target.value)}
                  disabled={!krakenAssets || krakenAssets.length === 0}
                  className="rounded-md border border-void-border bg-void-raised px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-amber/50 disabled:opacity-50"
                >
                  {krakenAssets === null && <option>loading…</option>}
                  {krakenAssets?.length === 0 && <option>no pairs found</option>}
                  {krakenAssets?.map((a) => (
                    <option key={a.pairKey} value={a.label}>
                      {a.label}
                    </option>
                  ))}
                </select>
              )}
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
                {source === 'binance' ? (
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
                ) : (
                  <select
                    value={krakenGranularity}
                    onChange={(e) => setKrakenGranularity(e.target.value as KrakenGranularity)}
                    className="rounded-md border border-void-border bg-void-raised px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-amber/50"
                  >
                    {KRAKEN_GRANULARITY_OPTIONS.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <button
                onClick={run}
                disabled={running || (source === 'kraken' && !krakenSymbol)}
                className="rounded-md border border-amber/40 bg-amber/10 px-3 py-1 font-mono text-[10px] font-bold tracking-wide text-amber-soft transition hover:bg-amber/20 disabled:opacity-50"
              >
                {running ? 'FETCHING…' : 'RUN BACKTEST'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-2 font-mono text-[10px] text-loss">
            {error} — {source === 'kraken' ? 'Kraken' : 'Binance'} may not list this pair, or the request was blocked
            (network/CORS/rate-limit).
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
              <Stat label="FILLS" value={result.fills.toLocaleString('en-US')} />
              <Stat label="TICKET CEILING BLOCKS" value={result.ticketCeilingBlocks.toLocaleString('en-US')} />
              <Stat label="KILL-SWITCH BLOCKS" value={result.killSwitchBlocks.toLocaleString('en-US')} positive={result.killSwitchBlocks === 0} />
            </div>
            <div className="mt-3">
              <Sparkline data={result.equityCurve} color={result.totalPnl >= 0 ? '#22c55e' : '#ef4444'} height={40} />
            </div>
            <p className="mt-1 font-mono text-[9px] text-slate-600">
              {result.ticks.toLocaleString('en-US')} decision ticks over {result.virtualHours.toLocaleString('en-US')}h simulated
            </p>
          </div>
        )}

        {history.length > 1 && (
          <div className="mt-4 border-t border-void-border pt-3">
            <div className="mb-1.5 font-mono text-[9px] tracking-wide text-slate-600">RECENT RUNS</div>
            <div className="space-y-1">
              {history.map((h, i) => (
                <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[10px] text-slate-500">
                  <span className="w-16 truncate text-slate-400" title={h.source === 'real' ? h.symbol : undefined}>
                    {h.source === 'real' ? h.symbol : 'synth'}
                  </span>
                  <span className="w-14 text-slate-400">{h.virtualHours.toLocaleString('en-US')}h</span>
                  <span className={h.totalPnl >= 0 ? 'text-profit' : 'text-loss'}>{formatPct(h.totalPnlPct, 1)}</span>
                  <span>{h.hitRatePct.toFixed(0)}% hit</span>
                  <span>sharpe {h.sharpe.toFixed(2)}</span>
                  <span>dd {h.maxDrawdownPct.toFixed(1)}%</span>
                  <span>{h.fills.toLocaleString('en-US')} fills</span>
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
