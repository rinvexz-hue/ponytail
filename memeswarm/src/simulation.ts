// PACKHUNT simulation engine — the ONLY file that knows this data is fake in
// one specific sense: trades are simulated (paper only, no order ever
// placed), but every price this engine trades against is real, live Kraken
// market data. It owns a private mutable state, advances it on a jittered
// tick loop, and hands the UI layer immutable snapshots via
// `start(onTick, onEvent)`.
//
// Two independent cadences drive this engine:
//  - A fast, jittered UI tick (250-800ms) that animates agent "mood",
//    writes flavor log entries, checks open positions against the latest
//    known price for an exit, and attempts new entries (probability scaled
//    to the real wall-clock time elapsed, so tick jitter never changes the
//    expected number of entries per real hour).
//  - A slower Kraken poll (~20s) that is the only place real market state
//    changes: it refreshes every tracked asset's price, recomputes each
//    asset's rolling volatility and trend, and updates the shared market
//    regime signal those decisions are gated on.

import type {
  ActionType,
  AgentId,
  AgentState,
  Candle,
  EventListener,
  KpiState,
  LogEntry,
  MarketStatus,
  Position,
  SimEvent,
  SimState,
  TickListener,
  TickerState,
} from './types'
import { AGENT_IDS } from './lib/agents'
import { discoverKrakenAssets, fetchKrakenTicker } from './lib/krakenData'
import type { KrakenAsset, KrakenTick } from './lib/krakenData'
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
  REAL_ENTRY_ATTEMPT_CHANCE_PER_HOUR,
  REAL_MOONSHOT_MAX_GAIN,
  REAL_MOONSHOT_MIN_GAIN,
  REAL_MOONSHOT_VOL_MULT,
  REAL_RISK_FLAG_CHANCE_PER_HOUR,
  REAL_STOP_LOSS_MAX_PCT,
  REAL_STOP_LOSS_MIN_PCT,
  REAL_STOP_LOSS_VOL_MULT,
  REAL_TRAIL_ARM_MAX_PCT,
  REAL_TRAIL_ARM_MIN_PCT,
  REAL_TRAIL_ARM_VOL_MULT,
  REAL_TRAIL_GIVEBACK_MAX_PCT,
  REAL_TRAIL_GIVEBACK_MIN_PCT,
  REAL_TRAIL_GIVEBACK_VOL_MULT,
  REAL_TREND_FAST_WINDOW,
  REAL_TREND_MIN_STREAK,
  REAL_TREND_SLOW_WINDOW,
  REAL_VOL_FLOOR,
  REAL_VOL_WINDOW,
  RISK_VETO_CHANCE,
  SEED_EQUITY,
  SESSION_LENGTH_HOURS,
} from './tuning'

// ---------- tunables ----------
const MIN_TICK_MS = 250
const MAX_TICK_MS = 800
const CANDLE_COUNT = 24
const TICKS_PER_CANDLE = 20
const SPARKLINE_LEN = 30
const EQUITY_SERIES_LEN = 60
const LOG_MAX = 60
const POLL_INTERVAL_MS = 20_000 // see krakenData.ts's ponytail note on Kraken's public rate-limit budget
const TRACK_WINDOW = REAL_VOL_WINDOW + REAL_TREND_SLOW_WINDOW

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
    'new 24h volume leader detected',
    'order book depth increased sharply',
    'spread tightened on watchlist pair',
    'listing re-scanned for signal',
  ],
  sniper: [
    'momentum confirmed',
    'entry signal triggered',
    'breakout above resistance',
    'volume spike on entry candle',
  ],
  sentiment: [
    'volatility regime turning bullish',
    'momentum broadening across the book',
    'trend confirmation strengthening',
    'market breadth improving',
  ],
  whalewatch: [
    'large order flow accumulating',
    'order book imbalance shifting bid-side',
    'block trade detected on the tape',
    'resting size building at the bid',
  ],
  liquidity: [
    'order book depth healthy',
    'slippage tolerance adjusted',
    'thin book — reducing size',
    'spread widened — re-checking',
  ],
  risk: [
    'volatility spike flagged',
    'abnormal spread detected',
    'drawdown check passed',
    'position exposure verified',
  ],
  exit: [
    'take-profit target hit',
    'stop-loss triggered',
    'trailing stop executed',
    'momentum fading — closing',
  ],
  treasury: [
    'settlement batch processed',
    'balances reconciled',
    'fee reserve topped up',
    'profit swept to treasury',
  ],
}

const RISK_FLAG_REASON = 'volatility risk flagged — exited'
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
  hasRealData: boolean
  closes: number[] // rolling price history — vol/trend are computed from this on each Kraken poll
  vol: number
  trendUpStreak: number
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
  entryVol: number // this asset's volatility AT ENTRY — exits are sized off this, not a fixed %, since the roster spans everything from BTC to illiquid microcaps
  openedAtCycle: number
  openedAt: number
}

class SwarmEngine {
  private cycle = 0
  private sessionStart = Date.now()
  private marketFactor = 0

  // Populated once discoverKrakenAssets() resolves — see bootstrap(). Empty
  // until then; the UI shows an empty ticker bar for that brief window
  // rather than inventing placeholder prices.
  private tickers: EngineTicker[] = []
  private assets: KrakenAsset[] = [] // Kraken's own pairKeys — needed for every poll() call, kept separate from EngineTicker's display-only fields
  private status: MarketStatus = 'connecting'
  private statusDetail: string | undefined
  private started = false
  private lastTickAt = Date.now()

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
  private pollTimer: ReturnType<typeof setTimeout> | null = null
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
  // restored — those re-resolve within seconds from Kraken and the regular
  // tick loop, and persisting them would just be stale noise.
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
    this.wins = saved.wins
    this.losses = saved.losses
    this.resolvedCount = saved.resolvedCount
    this.log = saved.log
    this.openPositions = saved.openPositions.map((p) => ({ ...p, entryVol: p.entryVol ?? REAL_VOL_FLOOR }))
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
    if (!this.started) {
      this.started = true
      this.bootstrap()
    }

    // Belt-and-braces save on tab close/refresh — the throttled save in
    // tick() covers normal play, but the last few seconds before closing
    // the tab could otherwise be lost.
    if (!this.unloadListenersAttached && typeof window !== 'undefined') {
      this.unloadListenersAttached = true
      const flush = () => this.persistNow()
      window.addEventListener('pagehide', flush)
      window.addEventListener('beforeunload', flush)
    }

    onTick(this.snapshot())
    return () => {
      this.tickListeners.delete(onTick)
      if (onEvent) this.eventListeners.delete(onEvent)
    }
  }

  stop() {
    if (this.timeoutId) clearTimeout(this.timeoutId)
    this.timeoutId = null
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  // Discovers Kraken's full tradable USD/USDT roster once, seeds a tracked
  // ticker per asset, then starts the recurring poll loop that is the only
  // place real market data changes (see the module comment).
  private async bootstrap() {
    let assets: KrakenAsset[]
    try {
      assets = await discoverKrakenAssets()
    } catch (e) {
      this.status = 'error'
      this.statusDetail = e instanceof Error ? e.message : 'failed to discover Kraken pairs'
      this.pollTimer = setTimeout(() => this.bootstrap(), POLL_INTERVAL_MS)
      return
    }
    if (assets.length === 0) {
      this.status = 'error'
      this.statusDetail = 'no tradable pairs discovered on Kraken'
      this.pollTimer = setTimeout(() => this.bootstrap(), POLL_INTERVAL_MS)
      return
    }

    this.assets = assets
    this.tickers = assets.map((a) => ({
      symbol: a.label,
      basePrice: 1,
      pct: 0,
      hasRealData: false,
      closes: [],
      vol: REAL_VOL_FLOOR,
      trendUpStreak: 0,
    }))

    this.poll()
  }

  private async poll() {
    try {
      const ticks = await fetchKrakenTicker(this.assets)
      const resolved = Object.keys(ticks).length
      if (resolved === this.assets.length) {
        this.status = 'live'
        this.statusDetail = undefined
      } else if (resolved > 0) {
        this.status = 'degraded'
        this.statusDetail = `${resolved}/${this.assets.length} pairs resolved`
      } else {
        this.status = 'error'
        this.statusDetail = 'no pairs resolved — check network/CORS'
      }
      this.applyKrakenPoll(ticks)
    } catch (e) {
      this.status = 'error'
      this.statusDetail = e instanceof Error ? e.message : 'Kraken poll failed'
    }
    this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS)
  }

  // The only place real market state changes: refreshes every tracked
  // asset's price, recomputes its rolling volatility and moving-average
  // trend, and updates the shared regime signal (marketFactor) that entry
  // decisions are gated on. Runs once per Kraken poll (~20s), independent
  // of the much faster cosmetic UI tick below.
  private applyKrakenPoll(ticks: Record<string, KrakenTick>) {
    const zScores: number[] = []

    for (const t of this.tickers) {
      const real = ticks[t.symbol]
      if (!real) continue
      t.basePrice = real.price
      t.pct = real.changePct
      t.hasRealData = true

      t.closes = pushCapped(t.closes, real.price, TRACK_WINDOW)
      if (t.closes.length >= 2) {
        const returns = diffs(t.closes).map((d, i) => d / t.closes[i])
        const window = returns.slice(-REAL_VOL_WINDOW)
        t.vol = window.length >= 5 ? stdDev(window) || REAL_VOL_FLOOR : REAL_VOL_FLOOR
        zScores.push(clamp(returns[returns.length - 1] / t.vol, -5, 5))

        const fastMa = mean(t.closes.slice(-REAL_TREND_FAST_WINDOW))
        const slowMa = mean(t.closes.slice(-REAL_TREND_SLOW_WINDOW))
        t.trendUpStreak = real.price > fastMa && fastMa > slowMa ? t.trendUpStreak + 1 : 0
      }
    }

    if (zScores.length > 0) {
      const zAvg = mean(zScores)
      this.marketFactor = clamp(this.marketFactor + zAvg * 0.03 - this.marketFactor * 0.06, -1, 1)
    }
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
    const now = Date.now()
    const hourFraction = (now - this.lastTickAt) / 3_600_000
    this.lastTickAt = now

    if (now - this.sessionStartAt >= SESSION_LENGTH_HOURS * 60 * 60 * 1000) {
      this.sessionStartAt = now
      this.sessionStartEquity = this.equity
      this.sessionEntries = 0
    }

    const flavorAppended = this.tickAgentsAndLog()
    const positionsAppended = this.tickPositions()
    const entryAppended = this.tryOpenPosition(hourFraction)
    this.tickEquity()
    this.tickCandle()
    this.tickMeters()
    this.maybePersist()

    this.pushOut(flavorAppended || positionsAppended || entryAppended)
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
    return t ? t.basePrice : 1
  }

  private slippageFor(notional: number): number {
    return clamp(0.0012 + notional / LIQUIDITY_DEPTH_USD, 0.0002, 0.08)
  }

  private pushLog(entry: Omit<LogEntry, 'id' | 'cycle' | 'timestamp'>) {
    const full: LogEntry = { id: uid(), cycle: this.cycle, timestamp: Date.now(), ...entry }
    this.log = [full, ...this.log].slice(0, LOG_MAX)
  }

  // Flavor-only: every agent logged here (everyone except SNIPER/EXIT, whose
  // real activity is wired to actual positions below) is narrating, not
  // trading. Equity/fills/wins/losses/volume24h all come exclusively from
  // tryOpenPosition()/closePosition() — never from a flavor log entry.
  private appendLogEntry(agentId: AgentId) {
    const action = choice(ACTIONS_BY_AGENT[agentId])
    const reason = choice(REASONS_BY_AGENT[agentId])
    const token = this.tickers.length > 0 ? choice(this.tickers).symbol : '—'
    this.pushLog({ agentId, action, token, pnl: null, reason })
  }

  // EXIT's discipline: cut a loser fast, let a winner run (only a trailing
  // stop, armed once meaningfully in profit, locks gains in) — all sized off
  // the volatility actually observed WHEN THIS POSITION WAS OPENED (an
  // ATR-style stop), not a fixed percentage. The roster spans BTC-scale
  // majors to thin microcaps, so a fixed 5% stop would be far too tight for
  // one and meaningless for the other; sizing off each position's own
  // entry-time volatility applies the same "how many standard deviations of
  // adverse move before this trade is wrong" logic to every asset alike.
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

      const stopPct = clamp(p.entryVol * REAL_STOP_LOSS_VOL_MULT, REAL_STOP_LOSS_MIN_PCT, REAL_STOP_LOSS_MAX_PCT)
      const trailArmPct = clamp(p.entryVol * REAL_TRAIL_ARM_VOL_MULT, REAL_TRAIL_ARM_MIN_PCT, REAL_TRAIL_ARM_MAX_PCT)
      const trailGivebackPct = clamp(
        p.entryVol * REAL_TRAIL_GIVEBACK_VOL_MULT,
        REAL_TRAIL_GIVEBACK_MIN_PCT,
        REAL_TRAIL_GIVEBACK_MAX_PCT,
      )
      const moonshotMult = 1 + clamp(p.entryVol * REAL_MOONSHOT_VOL_MULT, REAL_MOONSHOT_MIN_GAIN, REAL_MOONSHOT_MAX_GAIN)

      let reason: string | null = null
      if (current <= p.entryPrice * (1 - stopPct)) reason = 'stop-loss triggered'
      else if (current >= p.entryPrice * moonshotMult) reason = 'take-profit target hit'
      else if (current > p.entryPrice * (1 + trailArmPct) && current <= p.peakPrice * (1 - trailGivebackPct)) {
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

    this.pushLog({ agentId, action, token: p.token, pnl, reason })
  }

  // SNIPER's discipline: only buy with a clearly-confirmed regime
  // (marketFactor comfortably trending up, not just above zero), only when
  // SCOUT/SENTIMENT/WHALE-WATCH's composite reading genuinely agrees, only
  // on an asset whose own price is confirming an uptrend (fast MA above
  // slow MA for several ticks running), sized to conviction, and respecting
  // a RISK veto and the session's entry/drawdown containment.
  private tryOpenPosition(hourFraction: number): boolean {
    const agent = this.agents.sniper
    const activeChance = agent.status === 'EXECUTING' ? 0.55 : agent.status === 'SCANNING' ? 0.2 : agent.status === 'GUARDING' ? 0.15 : 0.05
    if (Math.random() >= activeChance) return false
    if (this.openPositions.length >= MAX_POSITIONS) return false

    const entryChance = 1 - Math.pow(1 - REAL_ENTRY_ATTEMPT_CHANCE_PER_HOUR, Math.max(hourFraction, 0))
    if (Math.random() >= entryChance) return false

    const tradeable = this.tickers.filter((t) => t.hasRealData)
    if (tradeable.length === 0) return false // no real prices yet — never invent an entry

    const riskGuarding = this.agents.risk.status === 'GUARDING'
    if (riskGuarding && Math.random() < RISK_VETO_CHANCE) {
      this.pushLog({ agentId: 'sniper', action: 'BUY', token: choice(tradeable).symbol, pnl: null, reason: RISK_VETO_REASON })
      return true
    }

    if (this.marketFactor <= ENTRY_REGIME_THRESHOLD) return false

    const signal = (this.agents.scout.value + this.agents.sentiment.value + this.agents.whalewatch.value) / 3
    if (signal <= MIN_SIGNAL_THRESHOLD) return false

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

    const heldTokens = new Set(this.openPositions.map((p) => p.token))
    const candidates = tradeable.filter((t) => !heldTokens.has(t.symbol) && t.trendUpStreak >= REAL_TREND_MIN_STREAK)
    if (candidates.length === 0) return false

    // An unbiased pick among trend-confirmed candidates, never the biggest
    // mover — chasing the loudest ticker means buying the local extreme
    // right before it reverts, measurably hurting the edge (see backtest.ts).
    const best = choice(candidates)
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
      entryVol: best.vol,
      openedAtCycle: this.cycle,
      openedAt: Date.now(),
    })

    this.fills += 1
    this.sessionEntries += 1
    this.volume24h += this.equity * randRange(0.0008, 0.006)
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

  private snapshot(): SimState {
    const tickers: TickerState[] = this.tickers.map((t) => ({
      symbol: t.symbol,
      price: t.basePrice,
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
      marketStatus: this.status,
      marketStatusDetail: this.statusDetail,
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
