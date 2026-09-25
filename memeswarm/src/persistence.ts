// Local-only persistence for PACKHUNT's trading history — saved to this
// browser's localStorage so equity, positions, and the trade log survive a
// page reload. Nothing here ever leaves the machine; there is no server, and
// nothing is shared between browsers or devices.

import type { Candle, LogEntry } from './types'
import { SEED_EQUITY } from './tuning'

// v1 -> v2: the meme-coin engine (fixed % exits, Dexscreener prices) was
// replaced with the Kraken-driven ATR engine — old saved equity/positions
// are from a different rule set entirely and would be actively misleading
// carried forward, not just stale. Bump this again for any future change
// with the same property.
const STORAGE_KEY = 'packhunt:v2'

// A session running for a long time (or one that lived through an earlier,
// buggy build) could in principle save a corrupted or wildly runaway
// number — nothing about localStorage guarantees it stays sane. This is a
// trust boundary (arbitrary prior state from this browser, not something
// this run computed), so a value outside any plausible real range is
// rejected outright rather than silently carried forward forever.
const MAX_PLAUSIBLE_EQUITY = SEED_EQUITY * 10_000

export interface PersistedPosition {
  id: string
  token: string
  entryPrice: number
  peakPrice: number
  units: number
  notional: number
  entryVol?: number // optional: absent in state saved before ATR-scaled exits shipped
  openedAtCycle: number
  openedAt: number
}

export interface PersistedState {
  v: 1
  cycle: number
  equity: number
  equitySeries: number[]
  pnlSeries: number[]
  hitRateSeries: number[]
  allTimeHighEquity: number
  volume24h: number
  fills: number
  wins: number
  losses: number
  resolvedCount: number
  log: LogEntry[]
  openPositions: PersistedPosition[]
  candles: Candle[]
  movingAverage: number[]
}

export function loadPersistedState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Partial<PersistedState>
    if (data.v !== 1 || !Array.isArray(data.candles) || data.candles.length === 0) return null
    if (!Number.isFinite(data.equity) || data.equity! <= 0 || data.equity! > MAX_PLAUSIBLE_EQUITY) return null
    return data as PersistedState
  } catch {
    return null // private browsing, corrupted data, or storage disabled — just start fresh
  }
}

export function savePersistedState(state: Omit<PersistedState, 'v'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...state }))
  } catch {
    // quota exceeded or storage disabled — trading still works, just not saved
  }
}
