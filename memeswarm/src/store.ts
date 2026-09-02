import { create } from 'zustand'
import { startAlphaRadarFeed } from './lib/alpharadarFeed'
import { swarmEngine } from './simulation'
import { playSoundForEvent } from './sounds'
import type { LogEntry, SimState, TickerState } from './types'

const LIVE_LOG_MAX = 60

interface SwarmStore extends SimState {
  selectedAgentId: string | null
  selectAgent: (id: string | null) => void
  // True once at least one real AlphaRadar event has arrived — lets the UI
  // (ActivityLog) show a "LIVE" badge instead of implying the feed is
  // simulated once it's actually real.
  alphaRadarConnected: boolean
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
  alphaRadarConnected: false,
}))

// Singleton: the engine starts once per app lifetime and pushes snapshots
// straight into the store. Sound events are routed separately so playing a
// sound never triggers a React re-render.
//
// AlphaRadar is layered on top rather than replacing the engine: it owns
// `log` and `tickers` once real events arrive (real signals, real prices),
// everything else (agents/candles/kpis/meters) stays simulated because
// AlphaRadar Fase 1 has no positions/PnL to report yet. The engine's own
// tick still fires every ~250-800ms with a full SimState snapshot, so the
// override has to happen on every tick, not just when a live event lands.
let liveLog: LogEntry[] = []
let liveTickers: Record<string, TickerState> = {}

swarmEngine.start(
  (snapshot) => {
    useSwarmStore.setState({
      ...snapshot,
      log: liveLog.length > 0 ? liveLog : snapshot.log,
      tickers: Object.keys(liveTickers).length > 0 ? Object.values(liveTickers) : snapshot.tickers,
    })
  },
  (event) => playSoundForEvent(event),
)

const ALPHARADAR_URL = import.meta.env.VITE_ALPHARADAR_URL as string | undefined
if (ALPHARADAR_URL) {
  startAlphaRadarFeed(ALPHARADAR_URL, {
    onLogEntry: (entry) => {
      liveLog = [entry, ...liveLog].slice(0, LIVE_LOG_MAX)
      useSwarmStore.setState({ log: liveLog })
    },
    onTicker: (ticker) => {
      liveTickers = { ...liveTickers, [ticker.symbol]: ticker }
      useSwarmStore.setState({ tickers: Object.values(liveTickers) })
    },
    onConnectionChange: (connected) => useSwarmStore.setState({ alphaRadarConnected: connected }),
  })
}
