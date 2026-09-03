// Local-only persistence for MEMESWARM's trading history — saved to this
// browser's localStorage so equity, positions, and the trade log survive a
// page reload. Nothing here ever leaves the machine; there is no server, and
// nothing is shared between browsers or devices.

import type { Candle, LogEntry } from './types'

// Bumped to v2 when the seed equity changed from $50,000 to $5,000 — old
// saved state from the $50K seed would otherwise load back in and clash
// with the new "seed $5.0K" label. Bump this again for any future change
// that would make previously-saved data misleading rather than just stale.
const STORAGE_KEY = 'memeswarm:v2'

export interface PersistedPosition {
  id: string
  token: string
  entryPrice: number
  peakPrice: number
  units: number
  notional: number
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
  venues: number
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
