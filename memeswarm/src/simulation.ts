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
  RealMarketTick,
  SimEvent,
  SimState,
  TickListener,
  TickerState,
} from './types'
import { AGENT_IDS, TICKER_SYMBOLS } from './lib/agents'
import { loadPersistedState, savePersistedState } from './persistence'
import { clamp, choice, diffs, mean, randNormal, randRange, stdDev, uid } from './lib/math'
import {
  AGENT_BETA,
  ENTRY_REGIME_THRESHOLD,
  LIQUIDITY_DEPTH_USD,
  MAX_ENTRIES_PER_SESSION,
  MAX_POSITIONS,
  MAX_SESSION_DRAWDOWN_PCT,
  MIN_SIGNAL_THRESHOLD,
  MOONSHOT_SAFETY_MULT,
  RISK_VETO_CHANCE,
  SEED_EQUITY,
  SESSION_LENGTH_HOURS,
  STOP_LOSS_PCT,
  TRAIL_ARM_PCT,
  TRAIL_GIVEBACK_PCT,
} from './tuning'

// ---------- tunables ----------
const MIN_TICK_MS = 250
const MAX_TICK_MS = 800
const CANDLE_COUNT = 24
const TICKS_PER_CANDLE = 20
const SPARKLINE_LEN = 30
const EQUITY_SERIES_LEN = 60
const LOG_MAX = 60

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
const KILL_SWITCH_REASON = 'entry blocked — session kill-switch tripped'
const TICKET_CEILING_REASON = 'entry blocked — session ticket ceiling reached'

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
// clamp/randRange/randNormal/choice/mean/stdDev/diffs/uid now live in
// ./lib/math so the backtester (backtest.ts) shares the exact same
// implementations — see the import at the top of this file.

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

// ---------- internal mutable engine state ----------
interface EngineTicker {
  symbol: string
  basePrice: number
  pct: number
  beta: number
  hasRealData: boolean
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

  // Placeholder prices only — real ones (Dexscreener) land via
  // applyRealMarketData() shortly after the engine starts. A ticker keeps
  // this placeholder, marked hasRealData: false, until its first real fetch
  // resolves; the UI shows those as "resolving" rather than inventing a price.
  private tickers: EngineTicker[] = TICKER_SYMBOLS.map((symbol, i) => ({
    symbol,
    basePrice: randRange(0.000002, 1.4) * (i % 3 === 0 ? 100 : 1),
    pct: randRange(-8, 8),
    beta: randRange(0.4, 1.1),
    hasRealData: false,
  }))

  // Real aggregate market momentum, derived from live prices — see
  // applyRealMarketData(). marketFactor (below) drifts around this instead
  // of around zero, so agent flavor/regime-gating tracks real conditions.
  private realMarketFactor = 0

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

  private lastPersistAt = 0
  private unloadListenersAttached = false

  // Session-level risk containment (see tuning.ts): a hard cap on new
  // entries per rolling real-time session, plus a circuit breaker that
  // halts new entries once the session's own drawdown gets too deep.
  // Neither touches positions already open — those still exit normally
  // through EXIT/RISK.
  private sessionStartAt = Date.now()
  private sessionStartEquity = SEED_EQUITY
  private sessionEntries = 0
  private ticketCeilingBlocks = 0
  private killSwitchBlocks = 0

  constructor() {
    if (!this.hydrateFromStorage()) this.seedCandles()
  }

  // Restores equity, positions, the trade log, and balance history from this
  // browser's localStorage (see persistence.ts) so a page reload doesn't
  // wipe out a session's trading. Ticker prices/agent flavor are NOT
  // restored — those re-resolve within seconds from Dexscreener and the
  // regular tick loop, and persisting them would just be stale noise.
  private hydrateFromStorage(): boolean {
    const saved = loadPersistedState()
    if (!saved) return false
    this.cycle = saved.cycle
    this.equity = saved.equity
    this.equitySeries = saved.equitySeries
    this.pnlSeries = saved.pnlSeries
    this.hitRateSeries = saved.hitRateSeries
    this.allTimeHighEquity = saved.allTimeHighEquity
    this.volume24h = saved.volume24h
    this.fills = saved.fills
    this.venues = saved.venues
    this.wins = saved.wins
    this.losses = saved.losses
    this.resolvedCount = saved.resolvedCount
    this.log = saved.log
    this.openPositions = saved.openPositions
    this.candles = saved.candles
    this.movingAverage = saved.movingAverage
    return true
  }

  private persistNow() {
    savePersistedState({
      cycle: this.cycle,
      equity: this.equity,
      equitySeries: this.equitySeries,
      pnlSeries: this.pnlSeries,
      hitRateSeries: this.hitRateSeries,
      allTimeHighEquity: this.allTimeHighEquity,
      volume24h: this.volume24h,
      fills: this.fills,
      venues: this.venues,
      wins: this.wins,
      losses: this.losses,
      resolvedCount: this.resolvedCount,
      log: this.log,
      openPositions: this.openPositions,
      candles: this.candles,
      movingAverage: this.movingAverage,
    })
  }

  // Throttled to once every few seconds — the tick loop runs 1-4x/second and
  // writing to localStorage on every tick would be wasteful I/O for data
  // that only needs to survive an accidental reload, not every millisecond.
  private maybePersist() {
    const now = Date.now()
    if (now - this.lastPersistAt < 4000) return
    this.lastPersistAt = now
    this.persistNow()
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

    // Belt-and-braces save on tab close/refresh — the throttled save in
    // tick() covers normal play, but the last few seconds before closing
    // the tab could otherwise be lost.
    if (!this.unloadListenersAttached && typeof window !== 'undefined') {
      this.unloadListenersAttached = true
      const flush = () => this.persistNow()
      window.addEventListener('pagehide', flush)
      window.addEventListener('beforeunload', flush)
    }

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

    if (Date.now() - this.sessionStartAt >= SESSION_LENGTH_HOURS * 60 * 60 * 1000) {
      this.sessionStartAt = Date.now()
      this.sessionStartEquity = this.equity
      this.sessionEntries = 0
    }

    // Agent flavor still jitters tick to tick (we have no live sentiment/
    // on-chain feed yet — see marketData.ts's module comment), but it now
    // drifts around realMarketFactor (derived from real prices) instead of
    // zero, so the swarm's "mood" tracks genuine market conditions.
    this.marketFactor = clamp(
      this.marketFactor + randNormal() * 0.03 + (this.realMarketFactor - this.marketFactor) * 0.06,
      -1,
      1,
    )

    this.tickTickers()
    const flavorAppended = this.tickAgentsAndLog()
    const positionsAppended = this.tickPositions()
    const entryAppended = this.tryOpenPosition()
    this.tickEquity()
    this.tickCandle()
    this.tickMeters()
    this.maybePersist()

    this.pushOut(flavorAppended || positionsAppended || entryAppended)
  }

  private tickTickers() {
    for (const t of this.tickers) {
      // Once a ticker has real Dexscreener data, its price/% change come
      // ONLY from applyRealMarketData() — no synthetic movement layered on
      // top. Before the first real fetch resolves, it fake-walks so the
      // ticker bar isn't a dead placeholder while data is loading.
      if (t.hasRealData) continue
      const move = t.beta * this.marketFactor * 0.6 + randNormal() * 0.5
      t.pct = clamp(t.pct + move, -95, 900)
      t.pct -= t.pct * 0.01
    }
  }

  // Real prices flow in here (see store.ts wiring marketDataEngine to this).
  // changePct is genuine (Dexscreener's 24h change) — we back-solve basePrice
  // so priceFor() = basePrice*(1+pct/100) reproduces the real priceUsd exactly,
  // without touching how the rest of the engine reads ticker prices.
  applyRealMarketData(ticks: Record<string, RealMarketTick>) {
    for (const t of this.tickers) {
      const real = ticks[t.symbol]
      if (!real) continue
      t.pct = real.changePct
      t.basePrice = real.priceUsd / (1 + real.changePct / 100)
      t.hasRealData = true
    }

    const withData = this.tickers.filter((t) => t.hasRealData)
    if (withData.length > 0) {
      this.realMarketFactor = clamp(mean(withData.map((t) => t.pct)) / 10, -1, 1)
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

  private slippageFor(notional: number): number {
    // worse LIQUIDITY reading -> thinner book -> more slippage on fills, plus
    // a market-impact term: a meme-coin pool has finite real depth, so a
    // position sized large relative to that depth eats real impact cost on
    // the way in and out. Without this, sizing a fixed % of equity every
    // trade compounds without limit — no real book fills an ever-larger
    // notional into the same shallow pool at the same cost.
    const liquidityValue = this.agents.liquidity.value
    const baseSlip = clamp(0.0012 - liquidityValue * 0.00015, 0.0002, 0.006)
    const impactSlip = clamp(notional / LIQUIDITY_DEPTH_USD, 0, 0.08)
    return baseSlip + impactSlip
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
    const current = this.priceFor(p.token)
    const slip = this.slippageFor(p.units * current)
    const exitPrice = current * (1 - slip)
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

  // SNIPER's discipline: only buy with a clearly-confirmed regime
  // (marketFactor comfortably trending up, not just above zero), only when
  // SCOUT/SENTIMENT/WHALE-WATCH's composite reading genuinely agrees (not
  // just "not too bearish"), size to that conviction, and respect a RISK
  // veto. Re-tuned via backtest.ts: firing on any marginal wobble produced
  // thousands of low-quality trades a month and a reliably negative
  // long-run edge (see tuning.ts). Waiting for real confirmation trades
  // roughly 85% less often but wins much more often when it does.
  private tryOpenPosition(): boolean {
    const agent = this.agents.sniper
    const activeChance = agent.status === 'EXECUTING' ? 0.55 : agent.status === 'SCANNING' ? 0.2 : agent.status === 'GUARDING' ? 0.15 : 0.05
    if (Math.random() >= activeChance) return false
    if (this.openPositions.length >= MAX_POSITIONS) return false

    const tradeable = this.tickers.filter((t) => t.hasRealData)
    if (tradeable.length === 0) return false // no real prices yet — never invent an entry

    const riskGuarding = this.agents.risk.status === 'GUARDING'
    if (riskGuarding && Math.random() < RISK_VETO_CHANCE) {
      this.pushLog({ agentId: 'sniper', action: 'BUY', token: choice(tradeable).symbol, pnl: null, reason: RISK_VETO_REASON })
      return true
    }

    if (this.marketFactor <= ENTRY_REGIME_THRESHOLD) return false

    const signal = (this.agents.scout.value + this.agents.sentiment.value + this.agents.whalewatch.value) / 3
    // SNIPER only fires when the desk actually agrees — a negative
    // composite reading used to still open a (smaller) position, which
    // contradicted the "only fires when SCOUT/SENTIMENT/WHALE-WATCH agree"
    // premise. Now it's a hard gate, not just a sizing input.
    if (signal <= MIN_SIGNAL_THRESHOLD) return false

    // Session risk containment (see tuning.ts): a circuit breaker that
    // halts new entries once this session's own drawdown gets too deep,
    // and a hard ceiling on new entries per session regardless of how good
    // the signal looks — both independent of per-trade entry quality, to
    // cap how much damage one bad streak can do.
    const killSwitchActive = this.equity <= this.sessionStartEquity * (1 - MAX_SESSION_DRAWDOWN_PCT / 100)
    if (killSwitchActive) {
      this.killSwitchBlocks += 1
      this.pushLog({ agentId: 'sniper', action: 'BUY', token: choice(tradeable).symbol, pnl: null, reason: KILL_SWITCH_REASON })
      return true
    }
    if (this.sessionEntries >= MAX_ENTRIES_PER_SESSION) {
      this.ticketCeilingBlocks += 1
      this.pushLog({ agentId: 'sniper', action: 'BUY', token: choice(tradeable).symbol, pnl: null, reason: TICKET_CEILING_REASON })
      return true
    }

    // Picking whichever ticker is currently moving hardest (by |24h %|)
    // was tested and measurably hurts the edge: it's buying the local
    // extreme, in whichever direction it happens to be, right before the
    // asset's next move — no different from chasing a pump into its own
    // dump. There's no per-ticker signal to genuinely pick a winner from
    // here, so an unbiased pick from the real-data pool outperforms trying
    // to be clever about it.
    const best = choice(tradeable)
    const token = best.symbol
    const sizeFrac = clamp(0.03 + signal * 0.006, 0.015, 0.12)
    const notional = this.equity * sizeFrac
    const slip = this.slippageFor(notional)
    const entryPrice = this.priceFor(token) * (1 + slip)

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
    this.sessionEntries += 1
    this.volume24h += this.equity * randRange(0.0008, 0.006)
    this.maybeDriftVenues()
    this.pushLog({ agentId: 'sniper', action: 'BUY', token, pnl: null, reason: choice(REASONS_BY_AGENT.sniper) })
    return true
  }

  private tickEquity() {
    // NET EQUITY is realized cash only (closePosition() is the only place
    // that moves it) — no synthetic per-tick wobble. Unrealized P&L on open
    // positions is tracked and displayed separately, from real prices, in
    // buildPositions(). Equity genuinely stays flat between real closes,
    // same as a real wallet balance would.
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
      // Sharpe-like ratio must be computed on RETURNS (tick-to-tick equity
      // deltas), not on the raw cumulative pnlSeries level — mean/stddev of
      // a monotonically trending level series is meaningless and pegs at
      // the clamp ceiling almost immediately. Diff the equity curve first.
      sharpe: clamp(mean(diffs(this.equitySeries.slice(-21))) / (stdDev(diffs(this.equitySeries.slice(-21))) || 1), -3, 3),
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
      hasRealData: t.hasRealData,
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
      riskSession: {
        entriesUsed: this.sessionEntries,
        entryLimit: MAX_ENTRIES_PER_SESSION,
        killSwitchActive: this.equity <= this.sessionStartEquity * (1 - MAX_SESSION_DRAWDOWN_PCT / 100),
        resetsAt: this.sessionStartAt + SESSION_LENGTH_HOURS * 60 * 60 * 1000,
      },
    }
  }

  private pushOut(_logAppended: boolean) {
    const state = this.snapshot()
    this.tickListeners.forEach((l) => l(state))
  }
}

export const swarmEngine = new SwarmEngine()
