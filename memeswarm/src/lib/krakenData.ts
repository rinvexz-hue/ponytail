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

export interface KrakenAssetPairInfo {
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

// Kraken's own base-asset codes are frequently not the display symbol
// (XXBT for Bitcoin, XETH for Ethereum, etc. — a legacy X/Z exchange-asset
// prefix). `wsname` ("XBT/USD") is Kraken's own already-clean display name
// and is preferred here; a regex strip on `base` is only a fallback for the
// rare pair missing wsname, since blindly stripping a leading X/Z risks
// mangling a genuinely X/Z-first modern ticker that isn't legacy-prefixed.
function displaySymbol(info: KrakenAssetPairInfo): string {
  const fromWsname = info.wsname?.split('/')[0]
  const raw = fromWsname || info.base.replace(/^[XZ](?=[A-Z0-9]{3,4}$)/, '')
  return raw === 'XBT' ? 'BTC' : raw
}

let cachedAssets: Promise<KrakenAsset[]> | null = null

// Discovers EVERY pair Kraken lists against USD (preferred) or USDT — the
// entire tradable universe on the exchange, not a curated allow-list. One
// base asset can have several quote currencies listed (BTC/USD, BTC/EUR,
// BTC/GBP, ...); this keeps exactly one pair per base, preferring the USD
// market so every position is priced in the same base currency. Cached for
// the session since the tradable pair list doesn't change minute to minute.
export async function discoverKrakenAssets(): Promise<KrakenAsset[]> {
  if (!cachedAssets) {
    cachedAssets = fetchAssetPairsAndResolve()
  }
  return cachedAssets
}

// Pure and exported (no network) so its dedup/preference logic can be
// exercised by a runnable check without hitting the real API — see
// scripts/check-kraken-discovery.ts.
export function resolveTradableAssets(pairs: Record<string, KrakenAssetPairInfo>): KrakenAsset[] {
  const byBase = new Map<string, { pairKey: string; info: KrakenAssetPairInfo; quotedInUsd: boolean }>()

  for (const [pairKey, info] of Object.entries(pairs)) {
    const altname = info.altname ?? ''
    const quotedInUsd = /USD$/.test(altname)
    const quotedInUsdt = /USDT$/.test(altname)
    if (!quotedInUsd && !quotedInUsdt) continue // only USD/USDT-quoted spot markets — keeps every position priced in one stable currency

    const base = displaySymbol(info)
    if (!base) continue

    const existing = byBase.get(base)
    // Prefer the direct USD market over USDT when a base asset lists both.
    if (!existing || (quotedInUsd && !existing.quotedInUsd)) {
      byBase.set(base, { pairKey, info, quotedInUsd })
    }
  }

  return [...byBase.entries()]
    .map(([label, { pairKey, info }]) => ({ label, pairKey, altname: info.altname }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function fetchAssetPairsAndResolve(): Promise<KrakenAsset[]> {
  return krakenGet<Record<string, KrakenAssetPairInfo>>('AssetPairs').then(resolveTradableAssets)
}

export interface KrakenTick {
  symbol: string
  price: number
  changePct: number // today's change vs. Kraken's own session-opening price
  updatedAt: number
}

// ponytail: Kraken's public rate limit for an unauthenticated client is a
// modest counter budget (documented around 15-20 call "credits", refilling
// over time), and a single Ticker call's URL grows with the pair list, so
// the full discovered roster (can be 250-400+ pairs) is polled in chunks
// instead of one enormous request. Ceiling: at ~100 pairs/call this is a
// handful of calls per poll — fine within budget at a 20s interval, but a
// roster growing much larger (or a shorter poll interval) would need a
// smaller chunk size or a longer interval to stay under Kraken's limit.
const TICKER_CHUNK_SIZE = 100

export async function fetchKrakenTicker(assets: KrakenAsset[]): Promise<Record<string, KrakenTick>> {
  if (assets.length === 0) return {}
  const now = Date.now()
  const out: Record<string, KrakenTick> = {}

  const chunks: KrakenAsset[][] = []
  for (let i = 0; i < assets.length; i += TICKER_CHUNK_SIZE) chunks.push(assets.slice(i, i + TICKER_CHUNK_SIZE))

  const results = await Promise.allSettled(
    chunks.map((chunk) =>
      krakenGet<Record<string, { c: [string, string]; o: string }>>('Ticker', {
        pair: chunk.map((a) => a.pairKey).join(','),
      }).then((result) => ({ chunk, result })),
    ),
  )

  for (const settled of results) {
    if (settled.status !== 'fulfilled') continue
    const { chunk, result } = settled.value
    for (const a of chunk) {
      const row = result[a.pairKey]
      const price = Number(row?.c?.[0])
      const openPrice = Number(row?.o)
      if (!Number.isFinite(price) || price <= 0) continue
      const changePct = Number.isFinite(openPrice) && openPrice > 0 ? ((price - openPrice) / openPrice) * 100 : 0
      out[a.label] = { symbol: a.label, price, changePct, updatedAt: now }
    }
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
