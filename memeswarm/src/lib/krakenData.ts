// Real market data from Kraken's public REST API — no API key, no auth, no
// wallet. Every function here hits only the /0/public/* endpoints (the same
// ones Kraken's own website charts use), never an account/order endpoint.
// This file is deliberately incapable of placing a trade: there is no
// signing, no key handling, nothing that reads an env var. Live order
// placement would be a separate, explicitly-scoped addition later.

const API_BASE = 'https://api.kraken.com/0/public'

interface KrakenApiResponse<T> {
  error: string[]
  result: T
}

async function krakenGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}/${path}`)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Kraken ${path} failed (HTTP ${res.status})`)
  const data = (await res.json()) as KrakenApiResponse<T>
  if (data.error?.length) throw new Error(`Kraken ${path} error: ${data.error.join(', ')}`)
  return data.result
}

interface KrakenAssetPairInfo {
  altname: string
  wsname?: string
  base: string
  quote: string
}

export interface KrakenAsset {
  label: string // display symbol, e.g. "BTC"
  pairKey: string // Kraken's own canonical result-object key for this pair, e.g. "XXBTZUSD" — used as-is for every subsequent request AND response lookup, so there's no altname/wsname ambiguity to get wrong
  altname: string
}

// Candidate base-asset codes per display symbol. Kraken renames some assets
// internally (XBT for Bitcoin, XDG for Dogecoin) and this has shifted across
// API versions, so trying several candidates against the live AssetPairs
// response is more robust than hardcoding one guess that might be stale.
const SYMBOL_CANDIDATES: Record<string, string[]> = {
  BTC: ['XBT', 'BTC'],
  ETH: ['ETH'],
  SOL: ['SOL'],
  DOGE: ['DOGE', 'XDG'],
  PEPE: ['PEPE'],
  WIF: ['WIF'],
  BONK: ['BONK'],
  SHIB: ['SHIB'],
}

let cachedAssets: Promise<KrakenAsset[]> | null = null

function findPairKey(entries: [string, KrakenAssetPairInfo][], candidates: string[]): [string, KrakenAssetPairInfo] | null {
  for (const c of candidates) {
    const exact = entries.find(([, info]) => info.altname === `${c}USD`)
    if (exact) return exact
  }
  for (const c of candidates) {
    const fuzzy = entries.find(([, info]) => info.altname?.startsWith(c) && /USDT?$/.test(info.altname))
    if (fuzzy) return fuzzy
  }
  return null
}

// Discovers which of our tracked symbols Kraken actually lists against USD
// (or USDT), and what Kraken's own canonical key is for each — cached for
// the session since the tradable pair list doesn't change minute to minute.
// Not every symbol in our roster will resolve: several (BRETT, MEW, TURBO,
// FLOKI, POPCAT) are Solana/Base-native meme coins that trade on-chain, not
// on Kraken — callers must only show/trade whatever comes back here, never
// assume the full roster is available.
export async function discoverKrakenAssets(): Promise<KrakenAsset[]> {
  if (!cachedAssets) {
    cachedAssets = fetchAssetPairsAndResolve()
  }
  return cachedAssets
}

async function fetchAssetPairsAndResolve(): Promise<KrakenAsset[]> {
  const pairs = await krakenGet<Record<string, KrakenAssetPairInfo>>('AssetPairs')
  const entries = Object.entries(pairs)
  const found: KrakenAsset[] = []
  for (const [label, candidates] of Object.entries(SYMBOL_CANDIDATES)) {
    const match = findPairKey(entries, candidates)
    if (match) found.push({ label, pairKey: match[0], altname: match[1].altname })
  }
  return found
}

export interface KrakenTick {
  symbol: string
  price: number
  updatedAt: number
}

// Fetches all assets in one call (Kraken's Ticker endpoint accepts a
// comma-separated pair list and this counts as a single request against the
// public rate limit, regardless of how many pairs are in it).
export async function fetchKrakenTicker(assets: KrakenAsset[]): Promise<Record<string, KrakenTick>> {
  if (assets.length === 0) return {}
  const pairParam = assets.map((a) => a.pairKey).join(',')
  const result = await krakenGet<Record<string, { c: [string, string] }>>('Ticker', { pair: pairParam })
  const now = Date.now()
  const out: Record<string, KrakenTick> = {}
  for (const a of assets) {
    const row = result[a.pairKey]
    const price = Number(row?.c?.[0])
    if (!Number.isFinite(price) || price <= 0) continue
    out[a.label] = { symbol: a.label, price, updatedAt: now }
  }
  return out
}

export interface KrakenCandle {
  time: number // ms epoch, candle open time
  close: number
}

export type KrakenGranularity = '5m' | '15m' | '1h' | '4h' | '1d'

const OHLC_INTERVAL_MINUTES: Record<KrakenGranularity, number> = {
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
}

type KrakenOhlcRow = [number, string, string, string, string, string, string, number]

// Kraken's OHLC endpoint returns only its most recent ~720 rows per call (no
// offset/limit param — paging forward is done via `since`, in seconds). For
// a long backtest window at fine granularity this means multiple calls,
// mirroring how lib/historicalData.ts pages Binance's klines endpoint.
const MAX_CALLS = 20

export async function fetchKrakenOHLC(
  pairKey: string,
  granularity: KrakenGranularity,
  days: number,
): Promise<{ candles: KrakenCandle[]; msPerCandle: number }> {
  const msPerCandle = OHLC_INTERVAL_MINUTES[granularity] * 60_000
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000

  const out: KrakenCandle[] = []
  let sinceSec = Math.floor(startTime / 1000)

  for (let i = 0; i < MAX_CALLS; i++) {
    const result = await krakenGet<Record<string, KrakenOhlcRow[] | number>>('OHLC', {
      pair: pairKey,
      interval: String(OHLC_INTERVAL_MINUTES[granularity]),
      since: String(sinceSec),
    })
    const rows = (result[pairKey] as KrakenOhlcRow[] | undefined) ?? []
    if (rows.length === 0) break

    for (const row of rows) {
      out.push({ time: row[0] * 1000, close: Number(row[4]) })
    }

    const lastOpenSec = rows[rows.length - 1][0]
    if (lastOpenSec <= sinceSec) break // no forward progress — avoid looping forever
    sinceSec = lastOpenSec
    if (lastOpenSec * 1000 >= Date.now() - msPerCandle) break // caught up to the present
  }

  if (out.length < 20) throw new Error(`Not enough Kraken history for ${pairKey} in that window`)
  return { candles: out, msPerCandle }
}
