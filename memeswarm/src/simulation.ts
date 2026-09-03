// MEMESWARM simulation engine — the ONLY file that knows this data is fake.
//
// It owns a private mutable state, advances it on a jittered tick loop, and
// hands the UI layer immutable snapshots via `start(onTick, onEvent)`.
// A real backend (Dexscreener/Birdeye/Pump.fun reads) can replace the body
// of `tick()` without any UI component ever knowing, as long as it keeps
// producing `SimState` snapshots shaped the same way.

import type {
  ActionType,
  AgentId,
  AgentState,
  Candle,
  EventListener,
  KpiState,
  LogEntry,
  Position,
  SimEvent,
  SimState,
  TickListener,
  TickerState,
} from './types'
import { AGENT_IDS, TICKER_SYMBOLS } from './lib/agents'

// ---------- tunables ----------
const MIN_TICK_MS = 250
const MAX_TICK_MS = 800
const CANDLE_COUNT = 24
const TICKS_PER_CANDLE = 20
const SPARKLINE_LEN = 30
const EQUITY_SERIES_LEN = 60
const MAX_POSITIONS = 6
const LOG_MAX = 60
const SEED_EQUITY = 50000

// Exit discipline: cut losers fast, let winners run uncapped (only a
// trailing stop, armed once meaningfully in profit, locks gains in).
// Tuned against a headless stats harness — see PR notes: a tight fixed
// take-profit amputates the fat right tail that this asset class's returns
// actually come from, while a trail that gives back more than it takes to
// arm can still lock in a net loss. TRAIL must stay well under TRAIL_ARM.
const STOP_LOSS_PCT = 0.07
const TRAIL_ARM_PCT = 0.1
const TRAIL_GIVEBACK_PCT = 0.05
const MOONSHOT_SAFETY_MULT = 2.5 // extreme-case cap only, almost never hit
const ENTRY_REGIME_THRESHOLD = 0.08 // only buy when the shared market factor is favorable
const RISK_VETO_CHANCE = 0.5 // chance RISK blocks a new entry while GUARDING

const ACTIONS_BY_AGENT: Record<AgentId, ActionType[]> = {
  scout: ['ROUTE', 'QUOTE'],
  sniper: ['BUY'],
  sentiment: ['QUOTE'],
  whalewatch: ['ROUTE', 'QUOTE'],
  liquidity: ['ROUTE'],
  risk: ['HEDGE'],
  exit: ['SELL'],
  treasury: ['FILL'],
}

const REASONS_BY_AGENT: Record<AgentId, string[]> = {
  scout: [
    'new pair detected on-chain',
    'liquidity pool just seeded',
    'fresh launch flagged for scan',
    'contract deployed under 2min ago',
  ],
  sniper: [
    'momentum confirmed',
    'entry signal triggered',
    'breakout above resistance',
    'volume spike on entry candle',
  ],
  sentiment: [
    'hype spike detected',
    'trending across socials',
    'influencer mention surge',
    'community sentiment turning bullish',
  ],
  whalewatch: [
    'large wallet accumulating',
    'whale wallet exited position',
    'smart money inflow detected',
    'top holder concentration rising',
  ],
  liquidity: [
    'pool depth healthy',
    'slippage tolerance adjusted',
    'thin liquidity — reducing size',
    'LP unlock detected',
  ],
  risk: [
    'contract ownership renounced',
    'honeypot check passed',
    'mint authority still active',
    'liquidity lock verified',
  ],
  exit: [
    'take-profit target hit',
    'stop-loss triggered',
    'trailing stop executed',
    'momentum fading — closing',
  ],
  treasury: [
    'settlement batch processed',
    'wallet rebalanced across venues',
    'gas reserve topped up',
    'profit swept to treasury',
  ],
}

const RISK_FLAG_REASON = 'rug risk flagged — exited'
const RISK_VETO_REASON = 'entry blocked — risk desk vetoed'

const AGENT_BETA: Record<AgentId, number> = {
  scout: 0.3,
  sniper: 0.9,
  sentiment: 0.6,
  whalewatch: 0.5,
  liquidity: 0.2,
  risk: -0.4,
  exit: 0.7,
  treasury: 0.15,
}

const STATUS_WEIGHTS: Record<AgentId, Partial<Record<AgentState['status'], number>>> = {
  scout: { SCANNING: 5, EXECUTING: 2, STANDBY: 2, IDLE: 1 },
  sniper: { EXECUTING: 3, SCANNING: 3, STANDBY: 3, IDLE: 1 },
  sentiment: { SCANNING: 5, EXECUTING: 2, STANDBY: 2 },
  whalewatch: { SCANNING: 4, GUARDING: 2, STANDBY: 2, EXECUTING: 1 },
  liquidity: { SCANNING: 4, STANDBY: 3, EXECUTING: 1, GUARDING: 1 },
  risk: { GUARDING: 5, SCANNING: 3, EXECUTING: 1, STANDBY: 1 },
  exit: { STANDBY: 4, EXECUTING: 3, SCANNING: 2, IDLE: 1 },
  treasury: { STANDBY: 4, IDLE: 3, EXECUTING: 2 },
}

// ---------- math helpers ----------
function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function randRange(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function randNormal() {
  // Box-Muller
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function choice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function weightedStatus(weights: Partial<Record<AgentState['status'], number>>): AgentState['status'] {
  const entries = Object.entries(weights) as [AgentState['status'], number][]
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let r = Math.random() * total
  for (const [status, w] of entries) {
    r -= w
    if (r <= 0) return status
  }
  return entries[0][0]
}

function pushCapped(arr: number[], value: number, cap: number): number[] {
  const next = arr.length >= cap ? arr.slice(arr.length - cap + 1) : arr.slice()
  next.push(value)
  return next
}

function mean(arr: number[]) {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function stdDev(arr: number[]) {
  if (arr.length < 2) return 0
  const m = mean(arr)
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)))
}

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

// ---------- internal mutable engine state ----------
interface EngineTicker {
  symbol: string
  basePrice: number
  pct: number
  beta: number
}

interface EngineAgent {
  id: AgentId
  status: AgentState['status']
  ticksInState: number
  value: number
  sparkline: number[]
}

interface EnginePosition {
  id: string
  token: string
  entryPrice: number
  peakPrice: number
  units: number
  notional: number
  openedAtCycle: number
  openedAt: number
}

class SwarmEngine {
  private cycle = 0
  private sessionStart = Date.now()
  private marketFactor = 0

  private tickers: EngineTicker[] = TICKER_SYMBOLS.map((symbol, i) => ({
    symbol,
    basePrice: randRange(0.000002, 1.4) * (i % 3 === 0 ? 100 : 1),
    pct: randRange(-8, 8),
    beta: randRange(0.4, 1.1),
  }))

  private agents: Record<AgentId, EngineAgent> = Object.fromEntries(
    AGENT_IDS.map((id) => [
      id,
      {
        id,
        status: 'STANDBY' as const,
        ticksInState: 0,
        value: randRange(-4, 4),
        sparkline: Array.from({ length: SPARKLINE_LEN }, () => randRange(-3, 3)),
      },
    ]),
  ) as Record<AgentId, EngineAgent>

  private equity = SEED_EQUITY
  private equitySeries: number[] = Array.from({ length: EQUITY_SERIES_LEN }, () => SEED_EQUITY)
  private pnlSeries: number[] = Array.from({ length: EQUITY_SERIES_LEN }, () => 0)
  private hitRateSeries: number[] = Array.from({ length: EQUITY_SERIES_LEN }, () => 50)
  private allTimeHighEquity = SEED_EQUITY
  private volume24h = 0
  private fills = 0
  private venues = 5
  private wins = 0
  private losses = 0
  private resolvedCount = 0

  private candles: Candle[] = []
  private ticksIntoCandle = 0
  private movingAverage: number[] = []

  private openPositions: EnginePosition[] = []

  private log: LogEntry[] = []
  private armLoad = 40
  private gripTorque = 55
  private alignment = 62

  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private tickListeners = new Set<TickListener>()
  private eventListeners = new Set<EventListener>()

  constructor() {
    this.seedCandles()
  }

  private seedCandles() {
    let price = this.equity
    const now = Date.now()
    const hourMs = 60 * 60 * 1000
    for (let i = CANDLE_COUNT; i >= 1; i--) {
      const open = price
      const drift = randNormal() * price * 0.004
      const close = clamp(open + drift, open * 0.9, open * 1.1)
      const high = Math.max(open, close) + Math.abs(randNormal()) * price * 0.002
      const low = Math.min(open, close) - Math.abs(randNormal()) * price * 0.002
      this.candles.push({
        time: now - i * hourMs,
        open,
        high,
        low,
        close,
        volume: randRange(800, 6000),
      })
      price = close
    }
    this.equity = price
    this.recomputeMovingAverage()
  }

  private recomputeMovingAverage() {
    const period = 5
    this.movingAverage = this.candles.map((_, idx) => {
      const start = Math.max(0, idx - period + 1)
      const slice = this.candles.slice(start, idx + 1)
      return mean(slice.map((c) => c.close))
    })
  }

  start(onTick: TickListener, onEvent?: EventListener) {
    this.tickListeners.add(onTick)
    if (onEvent) this.eventListeners.add(onEvent)
    if (!this.timeoutId) this.scheduleNext()
    onTick(this.snapshot(true))
    return () => {
      this.tickListeners.delete(onTick)
      if (onEvent) this.eventListeners.delete(onEvent)
    }
  }

  stop() {
    if (this.timeoutId) clearTimeout(this.timeoutId)
    this.timeoutId = null
  }

  private scheduleNext() {
    const delay = randRange(MIN_TICK_MS, MAX_TICK_MS)
    this.timeoutId = setTimeout(() => {
      this.tick()
      this.scheduleNext()
    }, delay)
  }

  private emit(event: SimEvent) {
    this.eventListeners.forEach((l) => l(event))
  }

  private tick() {
    this.cycle += 1

    // slow mean-reverting shared market factor drives coherent correlation
    this.marketFactor = clamp(this.marketFactor + randNormal() * 0.05 - this.marketFactor * 0.04, -1, 1)

    this.tickTickers()
    const flavorAppended = this.tickAgentsAndLog()
    const positionsAppended = this.tickPositions()
    const entryAppended = this.tryOpenPosition()
    this.tickEquity()
    this.tickCandle()
    this.tickMeters()

    this.pushOut(flavorAppended || positionsAppended || entryAppended)
  }

  private tickTickers() {
    for (const t of this.tickers) {
      const move = t.beta * this.marketFactor * 0.6 + randNormal() * 0.5
      t.pct = clamp(t.pct + move, -95, 900)
      // gentle mean reversion so tickers don't run away over a long session
      t.pct -= t.pct * 0.01
    }
  }

  private tickAgentsAndLog(): boolean {
    let appended = false

    for (const id of AGENT_IDS) {
      const agent = this.agents[id]
      agent.ticksInState += 1

      const minDwell = 4
      if (agent.ticksInState >= minDwell && Math.random() < 0.18) {
        const weights = STATUS_WEIGHTS[id]
        const next = weightedStatus(weights)
        if (next !== agent.status) {
          agent.status = next
          agent.ticksInState = 0
          if (next === 'EXECUTING') this.emit({ type: 'agentExecuting', agentId: id })
        }
      }

      const beta = AGENT_BETA[id]
      const drift = beta * this.marketFactor * 0.8 + randNormal() * 0.7
      agent.value = clamp(agent.value + drift - agent.value * 0.05, -40, 40)
      agent.sparkline = pushCapped(agent.sparkline, agent.value, SPARKLINE_LEN)

      // SNIPER and EXIT don't fire generic flavor log entries — their real
      // activity comes from tryOpenPosition()/tickPositions() below, which
      // are actually wired to the positions they open and close.
      if (id === 'sniper' || id === 'exit') continue

      const activeChance = agent.status === 'EXECUTING' ? 0.55 : agent.status === 'SCANNING' ? 0.2 : agent.status === 'GUARDING' ? 0.15 : 0.05
      if (Math.random() < activeChance) {
        this.appendLogEntry(id)
        appended = true
      }
    }

    return appended
  }

  private priceFor(symbol: string): number {
    const t = this.tickers.find((x) => x.symbol === symbol)
    if (!t) return 1
    return t.basePrice * (1 + t.pct / 100)
  }

  private slippageFor(): number {
    // worse LIQUIDITY reading -> thinner book -> more slippage on fills
    const liquidityValue = this.agents.liquidity.value
    return clamp(0.0012 - liquidityValue * 0.00015, 0.0002, 0.006)
  }

  private maybeDriftVenues() {
    if (Math.random() < 0.04) {
      this.venues = Math.round(clamp(this.venues + (Math.random() < 0.5 ? -1 : 1), 3, 9))
    }
  }

  private pushLog(entry: Omit<LogEntry, 'id' | 'cycle' | 'timestamp'>) {
    const full: LogEntry = { id: uid(), cycle: this.cycle, timestamp: Date.now(), ...entry }
    this.log = [full, ...this.log].slice(0, LOG_MAX)
  }

  private appendLogEntry(agentId: AgentId) {
    const action = choice(ACTIONS_BY_AGENT[agentId])
    const reason = choice(REASONS_BY_AGENT[agentId])
    const token = choice(this.tickers).symbol

    let pnl: number | null = null
    if (action === 'FILL' && Math.random() < 0.5) {
      pnl = randRange(-40, 60)
    }

    if (pnl !== null) {
      this.equity += pnl
      if (pnl > 0) this.emit({ type: 'profit', agentId, pnl })
      else if (pnl < 0) this.emit({ type: 'loss', agentId, pnl })
    }

    if (action === 'FILL') {
      this.fills += 1
      this.volume24h += this.equity * randRange(0.0008, 0.006)
    }

    this.maybeDriftVenues()
    this.pushLog({ agentId, action, token, pnl, reason })
  }

  // EXIT's discipline: cut a loser fast (STOP_LOSS_PCT), let a winner run
  // uncapped (only a trailing stop, armed once meaningfully in profit).
  // RISK's discipline: on a flag, force-close the single worst open
  // position immediately, regardless of EXIT's own rules.
  private tickPositions(): boolean {
    let appended = false
    const riskAgent = this.agents.risk
    const riskActiveChance = riskAgent.status === 'GUARDING' ? 0.15 : 0.05

    if (this.openPositions.length > 0 && Math.random() < riskActiveChance && Math.random() < 0.2) {
      let worstIdx = 0
      let worstPnl = Infinity
      this.openPositions.forEach((p, i) => {
        const pnl = (this.priceFor(p.token) - p.entryPrice) * p.units
        if (pnl < worstPnl) {
          worstPnl = pnl
          worstIdx = i
        }
      })
      const [closed] = this.openPositions.splice(worstIdx, 1)
      this.closePosition(closed, 'risk', 'HEDGE', RISK_FLAG_REASON)
      this.emit({ type: 'riskFlag', agentId: 'risk' })
      appended = true
    }

    for (let i = this.openPositions.length - 1; i >= 0; i--) {
      const p = this.openPositions[i]
      const current = this.priceFor(p.token)
      p.peakPrice = Math.max(p.peakPrice, current)

      let reason: string | null = null
      if (current <= p.entryPrice * (1 - STOP_LOSS_PCT)) reason = 'stop-loss triggered'
      else if (current >= p.entryPrice * MOONSHOT_SAFETY_MULT) reason = 'take-profit target hit'
      else if (current > p.entryPrice * (1 + TRAIL_ARM_PCT) && current <= p.peakPrice * (1 - TRAIL_GIVEBACK_PCT)) {
        reason = 'trailing stop executed'
      }

      if (reason) {
        this.openPositions.splice(i, 1)
        this.closePosition(p, 'exit', 'SELL', reason)
        appended = true
      }
    }

    return appended
  }

  private closePosition(p: EnginePosition, agentId: AgentId, action: ActionType, reason: string) {
    const slip = this.slippageFor()
    const exitPrice = this.priceFor(p.token) * (1 - slip)
    const pnl = (exitPrice - p.entryPrice) * p.units

    this.equity += pnl
    if (pnl > 0) {
      this.wins += 1
      this.emit({ type: 'profit', agentId, pnl })
    } else {
      this.losses += 1
      if (pnl < 0) this.emit({ type: 'loss', agentId, pnl })
    }
    this.resolvedCount += 1
    this.fills += 1
    this.volume24h += this.equity * randRange(0.0008, 0.006)

    this.maybeDriftVenues()
    this.pushLog({ agentId, action, token: p.token, pnl, reason })
  }

  // SNIPER's discipline: only buy with the regime (marketFactor trending
  // up), size to conviction (SCOUT/SENTIMENT/WHALE-WATCH consensus), pick
  // the ticker most leveraged to that regime, and respect a RISK veto.
  private tryOpenPosition(): boolean {
    const agent = this.agents.sniper
    const activeChance = agent.status === 'EXECUTING' ? 0.55 : agent.status === 'SCANNING' ? 0.2 : agent.status === 'GUARDING' ? 0.15 : 0.05
    if (Math.random() >= activeChance) return false
    if (this.openPositions.length >= MAX_POSITIONS) return false

    const riskGuarding = this.agents.risk.status === 'GUARDING'
    if (riskGuarding && Math.random() < RISK_VETO_CHANCE) {
      this.pushLog({ agentId: 'sniper', action: 'BUY', token: choice(this.tickers).symbol, pnl: null, reason: RISK_VETO_REASON })
      return true
    }

    if (this.marketFactor <= ENTRY_REGIME_THRESHOLD) return false

    const signal = (this.agents.scout.value + this.agents.sentiment.value + this.agents.whalewatch.value) / 3
    // Concentrate in the single most-leveraged ticker rather than spreading
    // across several. Tested: diversifying entries across the top 2-3 beta
    // tickers measurably weakens the edge here, because this asset class's
    // return is fat-tailed (see PR notes) — spreading size across several
    // tickers dilutes the odds that any one open position rides that tail,
    // the same reason a small high-conviction desk runs concentrated books.
    const best = this.tickers.reduce((a, b) => (b.beta > a.beta ? b : a))
    const token = best.symbol
    const sizeFrac = clamp(0.03 + signal * 0.006, 0.015, 0.12)
    const slip = this.slippageFor()
    const entryPrice = this.priceFor(token) * (1 + slip)
    const notional = this.equity * sizeFrac

    this.openPositions.push({
      id: uid(),
      token,
      entryPrice,
      peakPrice: entryPrice,
      units: notional / entryPrice,
      notional,
      openedAtCycle: this.cycle,
      openedAt: Date.now(),
    })

    this.fills += 1
    this.volume24h += this.equity * randRange(0.0008, 0.006)
    this.maybeDriftVenues()
    this.pushLog({ agentId: 'sniper', action: 'BUY', token, pnl: null, reason: choice(REASONS_BY_AGENT.sniper) })
    return true
  }

  private tickEquity() {
    // small mark-to-market drift on open exposure, on top of realized pnl above
    const mtm = this.equity * (this.marketFactor * 0.0006 + randNormal() * 0.0004)
    this.equity = Math.max(1000, this.equity + mtm)

    if (this.equity > this.allTimeHighEquity) {
      this.allTimeHighEquity = this.equity
      this.emit({ type: 'ath', equity: this.equity })
    }

    this.equitySeries = pushCapped(this.equitySeries, this.equity, EQUITY_SERIES_LEN)
    this.pnlSeries = pushCapped(this.pnlSeries, this.equity - SEED_EQUITY, EQUITY_SERIES_LEN)

    const totalTrades = this.wins + this.losses
    const hitRatePct = totalTrades > 0 ? (this.wins / totalTrades) * 100 : 50
    this.hitRateSeries = pushCapped(this.hitRateSeries, hitRatePct, EQUITY_SERIES_LEN)
  }

  private tickCandle() {
    this.ticksIntoCandle += 1
    const last = this.candles[this.candles.length - 1]
    const close = this.equity
    const high = Math.max(last.high, close)
    const low = Math.min(last.low, close)
    this.candles = [...this.candles.slice(0, -1), { ...last, close, high, low }]

    if (this.ticksIntoCandle >= TICKS_PER_CANDLE) {
      this.ticksIntoCandle = 0
      const newCandle: Candle = {
        time: Date.now(),
        open: close,
        high: close,
        low: close,
        close,
        volume: randRange(800, 6000),
      }
      this.candles = [...this.candles.slice(1), newCandle]
    }
    this.recomputeMovingAverage()
  }

  private tickMeters() {
    this.armLoad = clamp(this.armLoad + randNormal() * 3 + this.marketFactor * 2, 8, 96)
    this.gripTorque = clamp(this.gripTorque + randNormal() * 3 - this.marketFactor * 1.5, 8, 96)

    const totalTrades = this.wins + this.losses
    const hitRatePct = totalTrades > 0 ? (this.wins / totalTrades) * 100 : 50
    const riskDamp = this.agents.risk.status === 'GUARDING' ? -2 : 1
    const target = clamp(hitRatePct * 0.6 + (this.marketFactor + 1) * 20 + riskDamp * 3, 5, 98)
    this.alignment = clamp(this.alignment + (target - this.alignment) * 0.08 + randNormal() * 0.6, 0, 100)
  }

  private buildKpis(): KpiState {
    const totalPnl = this.equity - SEED_EQUITY
    const totalTrades = this.wins + this.losses
    return {
      netEquity: this.equity,
      netEquitySeries: this.equitySeries,
      seedEquity: SEED_EQUITY,
      totalPnl,
      totalPnlPct: (totalPnl / SEED_EQUITY) * 100,
      pnlSeries: this.pnlSeries,
      isAllTimeHigh: this.equity >= this.allTimeHighEquity,
      volume24h: this.volume24h,
      fills: this.fills,
      venues: this.venues,
      wins: this.wins,
      losses: this.losses,
      hitRatePct: totalTrades > 0 ? (this.wins / totalTrades) * 100 : 50,
      hitRateSeries: this.hitRateSeries,
      sharpe: clamp(mean(this.pnlSeries.slice(-20)) / (stdDev(this.pnlSeries.slice(-20)) || 1), -3, 3),
    }
  }

  private buildPositions(): Position[] {
    return this.openPositions.map((p) => {
      const currentPrice = this.priceFor(p.token)
      const unrealizedPnl = (currentPrice - p.entryPrice) * p.units
      return {
        id: p.id,
        token: p.token,
        entryPrice: p.entryPrice,
        currentPrice,
        units: p.units,
        notional: p.notional,
        unrealizedPnl,
        unrealizedPnlPct: (unrealizedPnl / p.notional) * 100,
        openedAtCycle: p.openedAtCycle,
        openedAt: p.openedAt,
      }
    })
  }

  private snapshot(_initial = false): SimState {
    const tickers: TickerState[] = this.tickers.map((t) => ({
      symbol: t.symbol,
      price: t.basePrice * (1 + t.pct / 100),
      changePct: t.pct,
      direction: t.pct >= 0 ? 1 : -1,
    }))

    const agents = Object.fromEntries(
      AGENT_IDS.map((id) => {
        const a = this.agents[id]
        const wasJustExecuted = a.status === 'EXECUTING' && a.ticksInState === 0
        return [
          id,
          {
            id,
            status: a.status,
            value: a.value,
            sparkline: a.sparkline,
            justExecuted: wasJustExecuted,
          } satisfies AgentState,
        ]
      }),
    ) as Record<AgentId, AgentState>

    return {
      cycle: this.cycle,
      sessionStart: this.sessionStart,
      tickers,
      agents,
      candles: this.candles,
      movingAverage: this.movingAverage,
      kpis: this.buildKpis(),
      positions: this.buildPositions(),
      log: this.log,
      resolvedCount: this.resolvedCount,
      armLoad: this.armLoad,
      gripTorque: this.gripTorque,
      alignment: this.alignment,
    }
  }

  private pushOut(_logAppended: boolean) {
    const state = this.snapshot()
    this.tickListeners.forEach((l) => l(state))
  }
}

export const swarmEngine = new SwarmEngine()
