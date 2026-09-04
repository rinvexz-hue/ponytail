import { create } from 'zustand'
import { swarmEngine } from './simulation'
import { marketDataEngine } from './marketData'
import { playSoundForEvent } from './sounds'
import type { MarketStatus, SimState } from './types'

interface SwarmStore extends SimState {
  selectedAgentId: string | null
  selectAgent: (id: string | null) => void
  marketStatus: MarketStatus
  marketStatusDetail?: string
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
  riskSession: {
    entriesUsed: 0,
    entryLimit: 0,
    killSwitchActive: false,
    resetsAt: Date.now(),
  },
}

export const useSwarmStore = create<SwarmStore>((set) => ({
  ...initialState,
  selectedAgentId: null,
  selectAgent: (id) => set({ selectedAgentId: id }),
  marketStatus: 'connecting',
  marketStatusDetail: undefined,
}))

// Singleton: the engine starts once per app lifetime and pushes snapshots
// straight into the store. Sound events are routed separately so playing a
// sound never triggers a React re-render.
swarmEngine.start(
  (snapshot) => useSwarmStore.setState(snapshot),
  (event) => playSoundForEvent(event),
)

// Real, read-only market data (Dexscreener) feeds straight into the sim
// engine's tickers — see marketData.ts and simulation.ts's
// applyRealMarketData(). No wallet, no execution, just genuine prices.
marketDataEngine.start(
  (ticks) => swarmEngine.applyRealMarketData(ticks),
  (status, detail) => useSwarmStore.setState({ marketStatus: status, marketStatusDetail: detail }),
)
