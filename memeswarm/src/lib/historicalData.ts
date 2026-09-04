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
// value can't turn into an unbounded number of calls.
const MAX_CALLS = 8

function intervalFor(days: number): { interval: string; msPerCandle: number } {
  if (days <= 2) return { interval: '5m', msPerCandle: 5 * 60_000 }
  if (days <= 10) return { interval: '15m', msPerCandle: 15 * 60_000 }
  if (days <= 30) return { interval: '1h', msPerCandle: 60 * 60_000 }
  if (days <= 200) return { interval: '4h', msPerCandle: 4 * 60 * 60_000 }
  return { interval: '1d', msPerCandle: 24 * 60 * 60_000 }
}

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string]

export async function fetchHistoricalCloses(pair: string, days: number): Promise<{ candles: RealCandle[]; msPerCandle: number }> {
  const { interval, msPerCandle } = intervalFor(days)
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
