// Real historical price data for the backtester's REAL DATA mode — fetched
// client-side, straight from Binance's public market-data API. No API key,
// no auth, no wallet: GET /api/v3/klines is a public, CORS-enabled endpoint
// used by countless read-only dashboards. This file never calls anything
// but that one endpoint, and never touches an account/order endpoint.
//
// If a symbol isn't listed on Binance, or the request fails, this throws —
// callers must not backfill with invented numbers (same rule marketData.ts
// follows for live prices).

export interface RealCandle {
  time: number // ms epoch, candle open time
  close: number
  quoteVolume: number
}

export interface RealDataAsset {
  label: string
  pair: string // Binance symbol, e.g. "PEPEUSDT"
}

// Curated list: the swarm's own meme-coin roster (see lib/agents.ts) plus a
// few majors, so the backtest can answer "does this edge hold outside meme
// coins too, over real history?" — not just synthetic data shaped to look
// like one asset class. Some roster tickers (MEW, BRETT, TURBO) may not be
// listed on Binance; picking those fails with a clear error rather than
// silently substituting a different asset.
export const REAL_DATA_ASSETS: RealDataAsset[] = [
  { label: 'BTC', pair: 'BTCUSDT' },
  { label: 'ETH', pair: 'ETHUSDT' },
  { label: 'SOL', pair: 'SOLUSDT' },
  { label: 'DOGE', pair: 'DOGEUSDT' },
  { label: 'PEPE', pair: 'PEPEUSDT' },
  { label: 'WIF', pair: 'WIFUSDT' },
  { label: 'BONK', pair: 'BONKUSDT' },
  { label: 'FLOKI', pair: 'FLOKIUSDT' },
  { label: 'POPCAT', pair: 'POPCATUSDT' },
]

const KLINES_ENDPOINT = 'https://api.binance.com/api/v3/klines'
const MAX_CANDLES_PER_CALL = 1000
// Caps how many pages a single request will fetch, so an oversized "days"
// value can't turn into an unbounded number of calls. 30 comfortably covers
// the heaviest realistic combination (3Y at 1h ≈ 26k candles ≈ 27 calls).
const MAX_CALLS = 30

// 'auto' keeps the original behavior (coarser candles for a longer window,
// so a default request stays fast and small). Picking an explicit
// granularity overrides that — e.g. requesting 1h candles over a full year
// on a low-volatility asset like BTC gives ~8,760 real decision points
// instead of the 365 a forced daily default would produce. Same real data
// either way, just more (or less) resolution on it.
export type Granularity = 'auto' | '5m' | '15m' | '1h' | '4h' | '1d'

const GRANULARITY_MS: Record<Exclude<Granularity, 'auto'>, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

export const GRANULARITY_OPTIONS: Granularity[] = ['auto', '5m', '15m', '1h', '4h', '1d']

function autoIntervalFor(days: number): { interval: string; msPerCandle: number } {
  if (days <= 2) return { interval: '5m', msPerCandle: GRANULARITY_MS['5m'] }
  if (days <= 10) return { interval: '15m', msPerCandle: GRANULARITY_MS['15m'] }
  if (days <= 30) return { interval: '1h', msPerCandle: GRANULARITY_MS['1h'] }
  // Was days<=200 → 4h, else 1d. A default "1 year" backtest (365 days) fell
  // into the 1d bucket, which serves only ~365 candles for the whole year —
  // too few decision points for the entry/trend gates to fire more than a
  // handful of times (measured: ~1.9 trades/year, 21% of runs with zero
  // trades at all — pure noise). 4h candles over the same year is ~2,190
  // candles (well within MAX_CALLS' budget) and gives the strategy enough
  // resolution to actually trade (measured: ~17.7 trades/year, 0% zero-trade
  // runs). Daily is now reserved for multi-year windows, where even at 4h the
  // candle count would get unwieldy.
  if (days <= 400) return { interval: '4h', msPerCandle: GRANULARITY_MS['4h'] }
  return { interval: '1d', msPerCandle: GRANULARITY_MS['1d'] }
}

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string]

export async function fetchHistoricalCloses(
  pair: string,
  days: number,
  granularity: Granularity = 'auto',
): Promise<{ candles: RealCandle[]; msPerCandle: number }> {
  const { interval, msPerCandle } =
    granularity === 'auto' ? autoIntervalFor(days) : { interval: granularity, msPerCandle: GRANULARITY_MS[granularity] }
  const endTime = Date.now()
  const startTime = endTime - days * 24 * 60 * 60 * 1000
  const candlesNeeded = Math.ceil((endTime - startTime) / msPerCandle)
  const callsNeeded = Math.min(MAX_CALLS, Math.max(1, Math.ceil(candlesNeeded / MAX_CANDLES_PER_CALL)))

  const out: RealCandle[] = []
  let cursor = startTime

  for (let i = 0; i < callsNeeded; i++) {
    const url = `${KLINES_ENDPOINT}?symbol=${pair}&interval=${interval}&startTime=${cursor}&limit=${MAX_CANDLES_PER_CALL}`
    const res = await fetch(url)
    if (!res.ok) {
      if (res.status === 400) throw new Error(`${pair} isn't listed on Binance`)
      throw new Error(`Binance request failed (HTTP ${res.status})`)
    }
    const rows = (await res.json()) as BinanceKline[]
    if (!Array.isArray(rows) || rows.length === 0) break

    for (const row of rows) {
      out.push({ time: Number(row[0]), close: Number(row[4]), quoteVolume: Number(row[7]) })
    }

    const lastOpenTime = Number(rows[rows.length - 1][0])
    if (lastOpenTime <= cursor) break // no forward progress — avoid looping forever
    cursor = lastOpenTime + msPerCandle
    if (cursor >= endTime) break
  }

  if (out.length < 20) throw new Error(`Not enough real history for ${pair} in that window`)
  return { candles: out, msPerCandle }
}
