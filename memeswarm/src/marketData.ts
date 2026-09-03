// Real, read-only market data — the ONLY file in this app that talks to the
// outside world, and it never sends a transaction, never touches a wallet.
// It polls Dexscreener's public API (no key required) for genuine prices on
// the tracked meme coins and hands snapshots to simulation.ts, which uses
// them in place of its synthetic random walk. If a symbol can't be resolved
// (network/CORS/rate-limit), that ticker is reported as unavailable rather
// than backfilled with invented numbers.

import type { MarketStatus, RealMarketTick } from './types'
import { TICKER_SYMBOLS } from './lib/agents'

const SEARCH_ENDPOINT = 'https://api.dexscreener.com/latest/dex/search'
const POLL_INTERVAL_MS = 10_000

export type MarketDataListener = (ticks: Record<string, RealMarketTick>) => void
export type MarketStatusListener = (status: MarketStatus, detail?: string) => void

interface DexPair {
  chainId?: string
  url?: string
  baseToken?: { symbol?: string }
  priceUsd?: string
  priceChange?: { h24?: number }
  liquidity?: { usd?: number }
  volume?: { h24?: number }
}

async function fetchSymbol(symbol: string): Promise<RealMarketTick | null> {
  try {
    const res = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(symbol)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { pairs?: DexPair[] }
    const pairs = Array.isArray(data.pairs) ? data.pairs : []
    if (pairs.length === 0) return null

    // prefer pairs whose base token symbol actually matches (search is fuzzy
    // and can return unrelated tokens that merely mention the query)
    const exact = pairs.filter((p) => p.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase())
    const pool = exact.length > 0 ? exact : pairs

    const best = pool.reduce((a, b) => (Number(b.liquidity?.usd ?? 0) > Number(a.liquidity?.usd ?? 0) ? b : a))
    const priceUsd = Number(best.priceUsd)
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null

    return {
      symbol,
      priceUsd,
      changePct: Number(best.priceChange?.h24 ?? 0),
      liquidityUsd: Number(best.liquidity?.usd ?? 0),
      volume24h: Number(best.volume?.h24 ?? 0),
      chainId: best.chainId ?? 'unknown',
      pairUrl: best.url ?? '',
      updatedAt: Date.now(),
    }
  } catch {
    return null
  }
}

class MarketDataEngine {
  private latest: Record<string, RealMarketTick> = {}
  private listeners = new Set<MarketDataListener>()
  private statusListeners = new Set<MarketStatusListener>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling = false

  start(onTick: MarketDataListener, onStatus?: MarketStatusListener) {
    this.listeners.add(onTick)
    if (onStatus) this.statusListeners.add(onStatus)
    if (!this.polling) {
      this.polling = true
      this.poll()
    }
    return () => {
      this.listeners.delete(onTick)
      if (onStatus) this.statusListeners.delete(onStatus)
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.polling = false
  }

  private async poll() {
    this.emitStatus('connecting')

    const results = await Promise.allSettled(TICKER_SYMBOLS.map((s) => fetchSymbol(s)))
    let resolved = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        this.latest[TICKER_SYMBOLS[i]] = r.value
        resolved += 1
      }
    })

    if (resolved === TICKER_SYMBOLS.length) this.emitStatus('live')
    else if (resolved > 0) this.emitStatus('degraded', `${resolved}/${TICKER_SYMBOLS.length} pairs resolved`)
    else this.emitStatus('error', 'no pairs resolved — check network/CORS')

    this.listeners.forEach((l) => l({ ...this.latest }))

    if (!this.polling) return
    this.timer = setTimeout(() => this.poll(), POLL_INTERVAL_MS)
  }

  private emitStatus(status: MarketStatus, detail?: string) {
    this.statusListeners.forEach((l) => l(status, detail))
  }
}

export const marketDataEngine = new MarketDataEngine()
