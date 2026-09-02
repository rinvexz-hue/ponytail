import { create } from 'zustand'
import { swarmEngine } from './simulation'
import { playSoundForEvent } from './sounds'
import type { SimState } from './types'

interface SwarmStore extends SimState {
  selectedAgentId: string | null
  selectAgent: (id: string | null) => void
}

const initialState: SimState = {
  cycle: 0,
  sessionStart: Date.now(),
  tickers: [],
  agents: {} as SimState['agents'],
  candles: [],
  movingAverage: [],
  kpis: {
    netEquity: 0,
    netEquitySeries: [],
    seedEquity: 0,
    totalPnl: 0,
    totalPnlPct: 0,
    pnlSeries: [],
    isAllTimeHigh: false,
    volume24h: 0,
    fills: 0,
    venues: 0,
    wins: 0,
    losses: 0,
    hitRatePct: 0,
    hitRateSeries: [],
    sharpe: 0,
  },
  positions: [],
  log: [],
  resolvedCount: 0,
  armLoad: 0,
  gripTorque: 0,
  alignment: 0,
}

export const useSwarmStore = create<SwarmStore>((set) => ({
  ...initialState,
  selectedAgentId: null,
  selectAgent: (id) => set({ selectedAgentId: id }),
}))

// Singleton: the engine starts once per app lifetime and pushes snapshots
// straight into the store. Sound events are routed separately so playing a
// sound never triggers a React re-render.
swarmEngine.start(
  (snapshot) => useSwarmStore.setState(snapshot),
  (event) => playSoundForEvent(event),
)
