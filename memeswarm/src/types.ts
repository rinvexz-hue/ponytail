// Shared, framework-agnostic types for the MEMESWARM dashboard.
// simulation.ts depends only on this file — no React/UI imports here,
// so the mock engine can later be swapped for a real data feed.

export type AgentId =
  | 'scout'
  | 'sniper'
  | 'sentiment'
  | 'whalewatch'
  | 'liquidity'
  | 'risk'
  | 'exit'
  | 'treasury'

export type AgentStatus = 'EXECUTING' | 'STANDBY' | 'IDLE' | 'SCANNING' | 'GUARDING'

export type ActionType = 'BUY' | 'SELL' | 'ROUTE' | 'FILL' | 'QUOTE' | 'HEDGE'

export interface AgentMeta {
  id: AgentId
  name: string
  role: string
  color: string
  glow: string
}

export interface AgentState {
  id: AgentId
  status: AgentStatus
  value: number // signed % — this agent's live edge/contribution
  sparkline: number[] // rolling buffer, last ~30 ticks
  justExecuted: boolean // true for the tick the agent entered EXECUTING
}

export interface TickerState {
  symbol: string
  price: number
  changePct: number
  direction: 1 | -1
  hasRealData: boolean
}

// Real, read-only market data pulled from a public API (Dexscreener) — no
// wallet, no execution, just genuine prices. See marketData.ts.
export interface RealMarketTick {
  symbol: string
  priceUsd: number
  changePct: number
  liquidityUsd: number
  volume24h: number
  chainId: string
  pairUrl: string
  updatedAt: number
}

export type MarketStatus = 'connecting' | 'live' | 'degraded' | 'error'

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface LogEntry {
  id: string
  cycle: number
  timestamp: number
  agentId: AgentId
  action: ActionType
  token: string
  pnl: number | null
  reason: string
}

export interface Position {
  id: string
  token: string
  entryPrice: number
  currentPrice: number
  units: number
  notional: number
  unrealizedPnl: number
  unrealizedPnlPct: number
  openedAtCycle: number
  openedAt: number
}

export interface KpiState {
  netEquity: number
  netEquitySeries: number[]
  seedEquity: number
  totalPnl: number
  totalPnlPct: number
  pnlSeries: number[]
  isAllTimeHigh: boolean
  volume24h: number
  fills: number
  venues: number
  wins: number
  losses: number
  hitRatePct: number
  hitRateSeries: number[]
  sharpe: number
}

export interface SimState {
  cycle: number
  sessionStart: number
  tickers: TickerState[]
  agents: Record<AgentId, AgentState>
  candles: Candle[]
  movingAverage: number[]
  kpis: KpiState
  positions: Position[]
  log: LogEntry[]
  resolvedCount: number
  armLoad: number
  gripTorque: number
  alignment: number
}

export type SimEvent =
  | { type: 'profit'; agentId: AgentId; pnl: number }
  | { type: 'loss'; agentId: AgentId; pnl: number }
  | { type: 'ath'; equity: number }
  | { type: 'riskFlag'; agentId: AgentId }
  | { type: 'agentExecuting'; agentId: AgentId }

export type TickListener = (state: SimState) => void
export type EventListener = (event: SimEvent) => void
