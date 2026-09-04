// Headless statistical backtester — runs the SAME entry/exit rules as the
// live engine (simulation.ts), but against fresh synthetic price action
// instead of real Dexscreener prices, and with no per-tick timers, so a
// week or a month of "trading" completes instantly instead of requiring
// you to sit and watch the live floor for that long.
//
// This is entirely separate from swarmEngine's state: running a backtest
// never reads or writes your live session's equity, positions, or trade
// log. It shares only the tuning constants in ./tuning, so a parameter
// change is tested identically in both places.
//
// The live engine's agent "mood" comes from a visual status state machine
// (STANDBY/SCANNING/EXECUTING/GUARDING) that governs how often each agent
// acts. Replaying that exactly here isn't worth the complexity for a
// statistical check, so entry attempts and risk-flag chances below are
// flat probabilities calibrated to match that state machine's long-run
// average — see the comments at ENTRY_ATTEMPT_CHANCE and RISK_FLAG_CHANCE.

import { TICKER_SYMBOLS } from './lib/agents'
import { choice, clamp, diffs, mean, randNormal, randRange, stdDev } from './lib/math'
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

// One decision point per simulated minute — plenty of resolution to judge
// whether the rules hold up, and it keeps even a year-long backtest done
// in well under a second.
const TICKS_PER_VIRTUAL_HOUR = 60
const MAX_VIRTUAL_HOURS = 8760 // 1 year
const MAX_TICKS = MAX_VIRTUAL_HOURS * TICKS_PER_VIRTUAL_HOUR

// SNIPER's live activeChance averages out to roughly this across its
// status-weighted dwell times (EXECUTING 0.55 / SCANNING 0.2 / STANDBY
// 0.05 / IDLE 0.05, weighted ~30/30/30/10). RISK_FLAG_CHANCE is the same
// calibration for how often RISK force-closes the worst open position.
const ENTRY_ATTEMPT_CHANCE = 0.25
const RISK_FLAG_CHANCE = 0.02

interface BtTicker {
  symbol: string
  basePrice: number
  pct: number
  beta: number
  momentum: number
}

interface BtPosition {
  token: string
  entryPrice: number
  peakPrice: number
  units: number
  notional: number
}

export interface BacktestResult {
  virtualHours: number
  ticks: number
  startEquity: number
  endEquity: number
  totalPnl: number
  totalPnlPct: number
  wins: number
  losses: number
  hitRatePct: number
  sharpe: number
  maxDrawdownPct: number
  bestTradePnl: number
  worstTradePnl: number
  fills: number
  equityCurve: number[]
  ticketCeilingBlocks: number
  killSwitchBlocks: number
}

export function runBacktest(virtualHours: number): BacktestResult {
  const hours = clamp(virtualHours, 1, MAX_VIRTUAL_HOURS)
  const ticks = Math.min(MAX_TICKS, Math.round(hours * TICKS_PER_VIRTUAL_HOUR))

  const tickers: BtTicker[] = TICKER_SYMBOLS.map((symbol, i) => ({
    symbol,
    basePrice: randRange(0.000002, 1.4) * (i % 3 === 0 ? 100 : 1),
    pct: randRange(-8, 8),
    beta: randRange(0.4, 1.1),
    momentum: 0,
  }))

  let marketFactor = 0
  let scoutVal = 0
  let sentimentVal = 0
  let whaleVal = 0
  let liquidityVal = 0

  let equity = SEED_EQUITY
  let peakEquity = SEED_EQUITY
  let maxDrawdownPct = 0
  let wins = 0
  let losses = 0
  let fills = 0
  let bestTradePnl = 0
  let worstTradePnl = 0
  const positions: BtPosition[] = []
  const equitySeries: number[] = [equity]

  // Session-level risk containment (see tuning.ts): a hard cap on new
  // entries per rolling session, plus a circuit breaker that halts new
  // entries once the session's own drawdown gets too deep. Both reset when
  // the session rolls over; neither touches positions already open.
  const ticksPerSession = SESSION_LENGTH_HOURS * TICKS_PER_VIRTUAL_HOUR
  let sessionStartTick = 0
  let sessionStartEquity = equity
  let sessionEntries = 0
  let ticketCeilingBlocks = 0
  let killSwitchBlocks = 0

  const priceFor = (t: BtTicker) => t.basePrice * (1 + t.pct / 100)
  // Base spread/depth slippage plus a market-impact term: a meme-coin pool
  // has finite real depth, so a position sized large relative to that depth
  // eats real impact cost on the way in and out. Without this term, sizing
  // a fixed % of equity every trade compounds without limit — no real book
  // fills an ever-larger dollar amount into the same shallow pool at the
  // same cost, which is exactly what let early tuning runs "backtest" into
  // literal quadrillion-percent returns.
  const slippageFor = (notional: number) =>
    clamp(0.0012 - liquidityVal * 0.00015, 0.0002, 0.006) + clamp(notional / LIQUIDITY_DEPTH_USD, 0, 0.08)
  const effectiveVetoChance = 0.5 * RISK_VETO_CHANCE // P(guarding) ~= 0.5 in the live status machine

  function recordFill(pnl: number) {
    equity += pnl
    fills += 1
    if (pnl > 0) wins += 1
    else losses += 1
    bestTradePnl = Math.max(bestTradePnl, pnl)
    worstTradePnl = Math.min(worstTradePnl, pnl)
  }

  const sampleEvery = Math.max(1, Math.floor(ticks / 300)) // downsample to ~300 points for the chart

  for (let i = 0; i < ticks; i++) {
    if (i - sessionStartTick >= ticksPerSession) {
      sessionStartTick = i
      sessionStartEquity = equity
      sessionEntries = 0
    }

    // Same mean-reverting drift as the live engine before real prices land
    // (no live data to anchor to here, so it just reverts toward zero).
    marketFactor = clamp(marketFactor + randNormal() * 0.03 - marketFactor * 0.06, -1, 1)

    for (const t of tickers) {
      // Real meme-coin moves have short-run autocorrelation — a pump tends
      // to keep pumping for a while, a dump keeps dumping — on top of pure
      // noise and macro beta. An earlier version of this model reverted
      // ~45% of any extension within a single simulated hour, which made
      // chasing the biggest recent mover a coin flip against itself and
      // silently rewarded contrarian entries that don't hold up on real
      // data. This version keeps some short-term persistence and only a
      // soft multi-day fade, closer to how a real meme coin actually decays
      // off a spike.
      const shock = t.beta * marketFactor * 0.6 + randNormal() * 0.5
      t.momentum = clamp(t.momentum * 0.93 + shock * 0.12, -3, 3)
      const move = shock + t.momentum
      t.pct = clamp(t.pct + move, -95, 900)
      t.pct -= t.pct * 0.0006
    }

    scoutVal = clamp(scoutVal + AGENT_BETA.scout * marketFactor * 0.8 + randNormal() * 0.7 - scoutVal * 0.05, -40, 40)
    sentimentVal = clamp(
      sentimentVal + AGENT_BETA.sentiment * marketFactor * 0.8 + randNormal() * 0.7 - sentimentVal * 0.05,
      -40,
      40,
    )
    whaleVal = clamp(
      whaleVal + AGENT_BETA.whalewatch * marketFactor * 0.8 + randNormal() * 0.7 - whaleVal * 0.05,
      -40,
      40,
    )
    liquidityVal = clamp(
      liquidityVal + AGENT_BETA.liquidity * marketFactor * 0.8 + randNormal() * 0.7 - liquidityVal * 0.05,
      -40,
      40,
    )

    // RISK occasionally force-closes the worst open position.
    if (positions.length > 0 && Math.random() < RISK_FLAG_CHANCE) {
      let worstIdx = 0
      let worstPnl = Infinity
      positions.forEach((p, idx) => {
        const ticker = tickers.find((t) => t.symbol === p.token)!
        const pnl = (priceFor(ticker) - p.entryPrice) * p.units
        if (pnl < worstPnl) {
          worstPnl = pnl
          worstIdx = idx
        }
      })
      const [closed] = positions.splice(worstIdx, 1)
      const ticker = tickers.find((t) => t.symbol === closed.token)!
      const current = priceFor(ticker)
      const exitPrice = current * (1 - slippageFor(closed.units * current))
      recordFill((exitPrice - closed.entryPrice) * closed.units)
    }

    // EXIT: stop-loss / moonshot safety cap / trailing stop.
    for (let idx = positions.length - 1; idx >= 0; idx--) {
      const p = positions[idx]
      const ticker = tickers.find((t) => t.symbol === p.token)!
      const current = priceFor(ticker)
      p.peakPrice = Math.max(p.peakPrice, current)

      const shouldClose =
        current <= p.entryPrice * (1 - STOP_LOSS_PCT) ||
        current >= p.entryPrice * MOONSHOT_SAFETY_MULT ||
        (current > p.entryPrice * (1 + TRAIL_ARM_PCT) && current <= p.peakPrice * (1 - TRAIL_GIVEBACK_PCT))

      if (shouldClose) {
        const exitPrice = current * (1 - slippageFor(p.units * current))
        recordFill((exitPrice - p.entryPrice) * p.units)
        positions.splice(idx, 1)
      }
    }

    // SNIPER: try to open a new position — same regime gate, signal gate,
    // conviction sizing and risk veto as the live engine. Ticker selection
    // is an unbiased pick from the tradeable pool, not the single mover
    // with the biggest |24h %|: a grid search over 486 parameter
    // combinations showed that "chase the biggest mover" measurably hurts
    // the edge (it's buying the local extreme right before it reverts),
    // while a plain unbiased pick performs as well or better and doesn't
    // rest on an unproven directional bet about price behavior.
    if (positions.length < MAX_POSITIONS && Math.random() < ENTRY_ATTEMPT_CHANCE && marketFactor > ENTRY_REGIME_THRESHOLD) {
      const killSwitchActive = equity <= sessionStartEquity * (1 - MAX_SESSION_DRAWDOWN_PCT / 100)
      if (killSwitchActive) {
        killSwitchBlocks += 1
      } else if (sessionEntries >= MAX_ENTRIES_PER_SESSION) {
        ticketCeilingBlocks += 1
      } else if (Math.random() >= effectiveVetoChance) {
        const signal = (scoutVal + sentimentVal + whaleVal) / 3
        if (signal > MIN_SIGNAL_THRESHOLD) {
          const best = choice(tickers)
          const sizeFrac = clamp(0.03 + signal * 0.006, 0.015, 0.12)
          const notional = equity * sizeFrac
          const entryPrice = priceFor(best) * (1 + slippageFor(notional))
          positions.push({ token: best.symbol, entryPrice, peakPrice: entryPrice, units: notional / entryPrice, notional })
          fills += 1
          sessionEntries += 1
        }
      }
    }

    peakEquity = Math.max(peakEquity, equity)
    const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct)

    if (i % sampleEvery === 0) equitySeries.push(equity)
  }

  equitySeries.push(equity)

  const totalTrades = wins + losses
  const totalPnl = equity - SEED_EQUITY
  const returns = diffs(equitySeries)
  const sharpe = clamp(mean(returns) / (stdDev(returns) || 1), -3, 3)

  return {
    virtualHours: hours,
    ticks,
    startEquity: SEED_EQUITY,
    endEquity: equity,
    totalPnl,
    totalPnlPct: (totalPnl / SEED_EQUITY) * 100,
    wins,
    losses,
    hitRatePct: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    sharpe,
    maxDrawdownPct,
    bestTradePnl,
    worstTradePnl,
    fills,
    equityCurve: equitySeries,
    ticketCeilingBlocks,
    killSwitchBlocks,
  }
}
