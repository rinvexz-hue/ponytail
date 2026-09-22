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
import type { RealCandle } from './lib/historicalData'
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
  source: 'synthetic' | 'real'
  symbol?: string
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
    source: 'synthetic',
  }
}

// --- REAL DATA mode ---------------------------------------------------
//
// Same entry/exit/session-containment rules as runBacktest above, driven by
// real historical closes (see lib/historicalData.ts, Binance's public
// klines API) instead of a synthetic random walk. Structurally parallel to
// runBacktest rather than sharing code with it, same as simulation.ts and
// runBacktest already are two independent implementations kept in sync only
// through tuning.ts — safer than threading a live/synthetic-data switch
// through the tuned-and-validated synthetic path above.
//
// Important honesty caveat: only the PRICE series is real. There is no
// historical feed for SCOUT/SENTIMENT/WHALE-WATCH's actual on-chain/social
// signals, so those three are approximated here as a shared momentum proxy
// derived from the real returns themselves (a burst of real upward
// momentum reads as a positive composite signal). That is a reasonable
// stand-in, not a replay of what those agents would really have seen — this
// validates the entry/exit/risk RULES against real price history, not the
// full agent decision process.
//
// There is also only one asset in play per run, so "pick the best ticker"
// collapses to "the one you picked" — MAX_POSITIONS effectively caps at 1
// concurrent position instead of spreading across a basket.
//
// Two things this mode deliberately does NOT inherit as fixed constants from
// the synthetic path, both found by re-deriving the math rather than by
// tuning against a target return (see the module comment on why that
// distinction matters):
//
// 1. marketFactor's innovation term must use the SAME 0.03 coefficient the
//    synthetic engine uses for randNormal() — z is already a rolling
//    z-score (~unit variance, same as randNormal()), so any other
//    coefficient changes marketFactor's steady-state volatility and silently
//    shifts what ENTRY_REGIME_THRESHOLD=0.18 actually means. (An earlier
//    version of this file used 0.06 here — double the synthetic engine's
//    calibration — which let the entry gate fire on much weaker conviction
//    than intended and diluted the edge with lower-quality entries.)
// 2. STOP_LOSS_PCT/TRAIL_ARM_PCT/MOONSHOT_SAFETY_MULT (tuning.ts) are fixed
//    percentages calibrated against the synthetic engine's meme-coin-scale
//    moves. Real assets span a much wider range (BTC's daily moves are a
//    fraction of a meme coin's) — a fixed 5% stop is tight enough to matter
//    for BTC but loose enough to rarely matter for a genuinely volatile
//    micro-cap. Real-data mode instead sizes each position's exits off the
//    volatility actually observed at entry (an ATR-style stop), so the same
//    "how many standard deviations of adverse move before this trade is
//    wrong" logic applies whether the asset picked is BTC or a meme coin.
// (Real-asset exit/entry calibration lives in tuning.ts now — REAL_VOL_*,
// REAL_*_CHANCE_PER_HOUR, REAL_STOP_*/REAL_TRAIL_*/REAL_MOONSHOT_*,
// REAL_TREND_* — shared with krakenEngine.ts's live paper-trading loop so
// both drive off the identical, already-validated calibration.)

interface RealPosition extends BtPosition {
  entryVol: number
}

function movingAverage(closes: number[], i: number, window: number): number {
  const start = Math.max(0, i - window + 1)
  let sum = 0
  for (let k = start; k <= i; k++) sum += closes[k]
  return sum / (i - start + 1)
}

export function runBacktestOnRealCandles(
  candles: { time: number; close: number }[],
  msPerCandle: number,
  symbol: string,
): BacktestResult {
  const closes = candles.map((c) => c.close)
  const returns: number[] = diffs(closes).map((d, i) => d / closes[i])
  const ticks = returns.length
  if (ticks < REAL_VOL_WINDOW + 5) throw new Error('Not enough real candles for a backtest')

  const rollingStd = (i: number) => {
    const window = returns.slice(Math.max(0, i - REAL_VOL_WINDOW), i)
    return window.length >= 5 ? stdDev(window) || REAL_VOL_FLOOR : REAL_VOL_FLOOR
  }

  let marketFactor = 0
  let scoutVal = 0
  let sentimentVal = 0
  let whaleVal = 0

  let equity = SEED_EQUITY
  let peakEquity = SEED_EQUITY
  let maxDrawdownPct = 0
  let wins = 0
  let losses = 0
  let fills = 0
  let bestTradePnl = 0
  let worstTradePnl = 0
  let position: RealPosition | null = null
  let trendUpStreak = 0
  const equitySeries: number[] = [equity]

  const ticksPerSession = Math.max(1, Math.round((SESSION_LENGTH_HOURS * 60 * 60_000) / msPerCandle))

  // ENTRY_ATTEMPT_CHANCE and REAL_RISK_FLAG_CHANCE were both being applied as
  // flat per-CANDLE probabilities, but they're calibrated per real HOUR (they
  // matched their intended rate exactly at msPerCandle=3_600_000, which is
  // what every prior round of tuning here validated against). A 1-year "AUTO"
  // request resolves to DAILY candles (see historicalData.ts), so the same
  // flat 0.25/0.005 chance was only rolling once a DAY instead of 24x/day —
  // collapsing entry attempts (and thus trade count) by ~24x and starving the
  // backtest down to 1-3 trades for the whole year, which is pure noise, not
  // signal. Compounding the per-hour rate up to whatever the candle actually
  // spans keeps the EXPECTED number of attempts per real year roughly
  // constant across every granularity the user can pick. At exactly hourly
  // candles this is a no-op (hourFraction=1 → identical to the old flat
  // value), so nothing about the hourly-validated behavior changes.
  const hourFraction = msPerCandle / 3_600_000
  const entryChancePerCandle = 1 - Math.pow(1 - REAL_ENTRY_ATTEMPT_CHANCE_PER_HOUR, hourFraction)
  const riskFlagChancePerCandle = 1 - Math.pow(1 - REAL_RISK_FLAG_CHANCE_PER_HOUR, hourFraction)

  let sessionStartTick = 0
  let sessionStartEquity = equity
  let sessionEntries = 0
  let ticketCeilingBlocks = 0
  let killSwitchBlocks = 0

  // Simpler than the synthetic mode's slippageFor: real klines don't carry a
  // calibrated depth signal (LIQUIDITY agent has no historical analog here),
  // so this only scales impact with position size, not with a liquidity
  // reading.
  const slippageFor = (notional: number) => clamp(0.0012 + notional / LIQUIDITY_DEPTH_USD, 0.0002, 0.08)
  const effectiveVetoChance = 0.5 * RISK_VETO_CHANCE

  function recordFill(pnl: number) {
    equity += pnl
    fills += 1
    if (pnl > 0) wins += 1
    else losses += 1
    bestTradePnl = Math.max(bestTradePnl, pnl)
    worstTradePnl = Math.min(worstTradePnl, pnl)
  }

  const sampleEvery = Math.max(1, Math.floor(ticks / 300))

  for (let i = 0; i < ticks; i++) {
    if (i - sessionStartTick >= ticksPerSession) {
      sessionStartTick = i
      sessionStartEquity = equity
      sessionEntries = 0
    }

    const vol = rollingStd(i)
    const z = clamp(returns[i] / vol, -5, 5)
    marketFactor = clamp(marketFactor + z * 0.03 - marketFactor * 0.06, -1, 1)
    const price = closes[i + 1]

    const fastMa = movingAverage(closes, i, REAL_TREND_FAST_WINDOW)
    const slowMa = movingAverage(closes, i, REAL_TREND_SLOW_WINDOW)
    trendUpStreak = price > fastMa && fastMa > slowMa ? trendUpStreak + 1 : 0

    scoutVal = clamp(scoutVal + AGENT_BETA.scout * marketFactor * 0.8 + z * 0.7 - scoutVal * 0.05, -40, 40)
    sentimentVal = clamp(sentimentVal + AGENT_BETA.sentiment * marketFactor * 0.8 + z * 0.7 - sentimentVal * 0.05, -40, 40)
    whaleVal = clamp(whaleVal + AGENT_BETA.whalewatch * marketFactor * 0.8 + z * 0.7 - whaleVal * 0.05, -40, 40)

    // RISK occasionally force-closes the open position.
    if (position && Math.random() < riskFlagChancePerCandle) {
      const exitPrice = price * (1 - slippageFor(position.units * price))
      recordFill((exitPrice - position.entryPrice) * position.units)
      position = null
    }

    // EXIT: stop-loss / moonshot safety cap / trailing stop, all sized off
    // the volatility observed when THIS position was opened (see the
    // module comment above) rather than the synthetic engine's fixed %s.
    if (position) {
      position.peakPrice = Math.max(position.peakPrice, price)
      const stopPct = clamp(position.entryVol * REAL_STOP_LOSS_VOL_MULT, REAL_STOP_LOSS_MIN_PCT, REAL_STOP_LOSS_MAX_PCT)
      const trailArmPct = clamp(position.entryVol * REAL_TRAIL_ARM_VOL_MULT, REAL_TRAIL_ARM_MIN_PCT, REAL_TRAIL_ARM_MAX_PCT)
      const trailGivebackPct = clamp(
        position.entryVol * REAL_TRAIL_GIVEBACK_VOL_MULT,
        REAL_TRAIL_GIVEBACK_MIN_PCT,
        REAL_TRAIL_GIVEBACK_MAX_PCT,
      )
      const moonshotMult =
        1 + clamp(position.entryVol * REAL_MOONSHOT_VOL_MULT, REAL_MOONSHOT_MIN_GAIN, REAL_MOONSHOT_MAX_GAIN)
      const shouldClose =
        price <= position.entryPrice * (1 - stopPct) ||
        price >= position.entryPrice * moonshotMult ||
        (price > position.entryPrice * (1 + trailArmPct) && price <= position.peakPrice * (1 - trailGivebackPct))
      if (shouldClose) {
        const exitPrice = price * (1 - slippageFor(position.units * price))
        recordFill((exitPrice - position.entryPrice) * position.units)
        position = null
      }
    }

    // SNIPER: same regime gate, signal gate, conviction sizing and risk veto,
    // plus the trend-confirmation gate above (see module comment).
    if (
      !position &&
      Math.random() < entryChancePerCandle &&
      marketFactor > ENTRY_REGIME_THRESHOLD &&
      trendUpStreak >= REAL_TREND_MIN_STREAK
    ) {
      const killSwitchActive = equity <= sessionStartEquity * (1 - MAX_SESSION_DRAWDOWN_PCT / 100)
      if (killSwitchActive) {
        killSwitchBlocks += 1
      } else if (sessionEntries >= MAX_ENTRIES_PER_SESSION) {
        ticketCeilingBlocks += 1
      } else if (Math.random() >= effectiveVetoChance) {
        const signal = (scoutVal + sentimentVal + whaleVal) / 3
        if (signal > MIN_SIGNAL_THRESHOLD) {
          const sizeFrac = clamp(0.03 + signal * 0.006, 0.015, 0.12)
          const notional = equity * sizeFrac
          const entryPrice = price * (1 + slippageFor(notional))
          position = { token: symbol, entryPrice, peakPrice: entryPrice, units: notional / entryPrice, notional, entryVol: vol }
          fills += 1
          sessionEntries += 1
        }
      }
    }

    peakEquity = Math.max(peakEquity, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0)
    if (i % sampleEvery === 0) equitySeries.push(equity)
  }

  equitySeries.push(equity)

  const totalTrades = wins + losses
  const totalPnl = equity - SEED_EQUITY
  const equityReturns = diffs(equitySeries)
  const sharpe = clamp(mean(equityReturns) / (stdDev(equityReturns) || 1), -3, 3)
  const virtualHours = (ticks * msPerCandle) / (60 * 60_000)

  return {
    virtualHours,
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
    source: 'real',
    symbol,
  }
}

// --- LIVE RULES on a REAL multi-asset basket ----------------------------
//
// Tests the EXACT rule set the live meme-coin engine (simulation.ts) and
// runBacktest's synthetic mode above actually trade with — fixed
// STOP_LOSS_PCT/TRAIL_ARM_PCT/TRAIL_GIVEBACK_PCT/MOONSHOT_SAFETY_MULT,
// unbiased entry pick across several real assets at once, no trend-
// confirmation gate (the live engine doesn't have one either) — against
// real historical closes instead of a synthetic walk. Deliberately does
// NOT reuse runBacktestOnRealCandles's ATR-scaled REAL_* thresholds: those
// validate a DIFFERENT rule set, calibrated for majors like BTC, not the
// one actually running live. Real-time calibration (entry-attempt/risk-
// flag chance, session length) still comes from the REAL_*_PER_HOUR
// constants — those are genuinely about wall-clock timing, not about
// which asset class the exit-sizing math assumes.
export interface RealBasketAsset {
  label: string
  candles: RealCandle[]
}

interface BasketPosition {
  token: string
  entryPrice: number
  peakPrice: number
  units: number
  notional: number
}

export function runBacktestOnRealBasket(assets: RealBasketAsset[], msPerCandle: number): BacktestResult {
  const withEnough = assets.filter((a) => a.candles.length >= REAL_VOL_WINDOW + 5)
  if (withEnough.length === 0) throw new Error('Not enough real candles for a basket backtest')

  // Some pairs got listed on Binance later than others, so a naive
  // index-for-index zip would silently compare two different points in
  // time. Intersecting by timestamp guarantees index i is the same moment
  // across every asset.
  let commonTimes: number[] | null = null
  for (const a of withEnough) {
    const times = new Set(a.candles.map((c) => c.time))
    commonTimes = commonTimes === null ? [...times] : commonTimes.filter((t) => times.has(t))
  }
  commonTimes = (commonTimes ?? []).sort((a, b) => a - b)
  if (commonTimes.length < REAL_VOL_WINDOW + 5) {
    throw new Error('Not enough overlapping real history across the basket')
  }

  const labels = withEnough.map((a) => a.label)
  const closesBySymbol: Record<string, number[]> = {}
  for (const a of withEnough) {
    const byTime = new Map(a.candles.map((c) => [c.time, c.close]))
    closesBySymbol[a.label] = commonTimes.map((t) => byTime.get(t) as number)
  }
  const returnsBySymbol: Record<string, number[]> = {}
  for (const label of labels) {
    returnsBySymbol[label] = diffs(closesBySymbol[label]).map((d, i) => d / closesBySymbol[label][i])
  }

  const rollingStd = (label: string, i: number) => {
    const window = returnsBySymbol[label].slice(Math.max(0, i - REAL_VOL_WINDOW), i)
    return window.length >= 5 ? stdDev(window) || REAL_VOL_FLOOR : REAL_VOL_FLOOR
  }

  let marketFactor = 0
  let scoutVal = 0
  let sentimentVal = 0
  let whaleVal = 0

  let equity = SEED_EQUITY
  let peakEquity = SEED_EQUITY
  let maxDrawdownPct = 0
  let wins = 0
  let losses = 0
  let fills = 0
  let bestTradePnl = 0
  let worstTradePnl = 0
  const positions: BasketPosition[] = []
  const equitySeries: number[] = [equity]

  const ticks = commonTimes.length - 1
  const ticksPerSession = Math.max(1, Math.round((SESSION_LENGTH_HOURS * 60 * 60_000) / msPerCandle))
  let sessionStartTick = 0
  let sessionStartEquity = equity
  let sessionEntries = 0
  let ticketCeilingBlocks = 0
  let killSwitchBlocks = 0

  const hourFraction = msPerCandle / 3_600_000
  const entryChancePerCandle = 1 - Math.pow(1 - REAL_ENTRY_ATTEMPT_CHANCE_PER_HOUR, hourFraction)
  const riskFlagChancePerCandle = 1 - Math.pow(1 - REAL_RISK_FLAG_CHANCE_PER_HOUR, hourFraction)
  const effectiveVetoChance = 0.5 * RISK_VETO_CHANCE

  const slippageFor = (notional: number) => clamp(0.0012 + notional / LIQUIDITY_DEPTH_USD, 0.0002, 0.08)

  function recordFill(pnl: number) {
    equity += pnl
    fills += 1
    if (pnl > 0) wins += 1
    else losses += 1
    bestTradePnl = Math.max(bestTradePnl, pnl)
    worstTradePnl = Math.min(worstTradePnl, pnl)
  }

  const sampleEvery = Math.max(1, Math.floor(ticks / 300))

  for (let i = 0; i < ticks; i++) {
    if (i - sessionStartTick >= ticksPerSession) {
      sessionStartTick = i
      sessionStartEquity = equity
      sessionEntries = 0
    }

    const priceAt = (label: string) => closesBySymbol[label][i + 1]

    const zScores = labels.map((label) => {
      const vol = rollingStd(label, i)
      return clamp(returnsBySymbol[label][i] / vol, -5, 5)
    })
    const zAvg = mean(zScores)
    marketFactor = clamp(marketFactor + zAvg * 0.03 - marketFactor * 0.06, -1, 1)
    scoutVal = clamp(scoutVal + AGENT_BETA.scout * marketFactor * 0.8 + zAvg * 0.7 - scoutVal * 0.05, -40, 40)
    sentimentVal = clamp(sentimentVal + AGENT_BETA.sentiment * marketFactor * 0.8 + zAvg * 0.7 - sentimentVal * 0.05, -40, 40)
    whaleVal = clamp(whaleVal + AGENT_BETA.whalewatch * marketFactor * 0.8 + zAvg * 0.7 - whaleVal * 0.05, -40, 40)

    // RISK: occasionally force-closes the worst open position.
    if (positions.length > 0 && Math.random() < riskFlagChancePerCandle) {
      let worstIdx = 0
      let worstPnl = Infinity
      positions.forEach((p, idx) => {
        const price = priceAt(p.token)
        const pnl = (price - p.entryPrice) * p.units
        if (pnl < worstPnl) {
          worstPnl = pnl
          worstIdx = idx
        }
      })
      const [closed] = positions.splice(worstIdx, 1)
      const price = priceAt(closed.token)
      const exitPrice = price * (1 - slippageFor(closed.units * price))
      recordFill((exitPrice - closed.entryPrice) * closed.units)
    }

    // EXIT: stop-loss / moonshot cap / trailing stop — the SAME fixed
    // thresholds the live meme-coin engine actually trades with.
    for (let idx = positions.length - 1; idx >= 0; idx--) {
      const p = positions[idx]
      const price = priceAt(p.token)
      p.peakPrice = Math.max(p.peakPrice, price)
      const shouldClose =
        price <= p.entryPrice * (1 - STOP_LOSS_PCT) ||
        price >= p.entryPrice * MOONSHOT_SAFETY_MULT ||
        (price > p.entryPrice * (1 + TRAIL_ARM_PCT) && price <= p.peakPrice * (1 - TRAIL_GIVEBACK_PCT))
      if (shouldClose) {
        const exitPrice = price * (1 - slippageFor(p.units * price))
        recordFill((exitPrice - p.entryPrice) * p.units)
        positions.splice(idx, 1)
      }
    }

    // SNIPER: same regime gate, signal gate, conviction sizing, risk veto
    // and session containment as the live engine and the synthetic
    // backtest — an unbiased pick among currently-held-free basket assets,
    // never the biggest mover (see runBacktest's module comment on why).
    if (positions.length < MAX_POSITIONS && Math.random() < entryChancePerCandle && marketFactor > ENTRY_REGIME_THRESHOLD) {
      const killSwitchActive = equity <= sessionStartEquity * (1 - MAX_SESSION_DRAWDOWN_PCT / 100)
      if (killSwitchActive) {
        killSwitchBlocks += 1
      } else if (sessionEntries >= MAX_ENTRIES_PER_SESSION) {
        ticketCeilingBlocks += 1
      } else if (Math.random() >= effectiveVetoChance) {
        const signal = (scoutVal + sentimentVal + whaleVal) / 3
        if (signal > MIN_SIGNAL_THRESHOLD) {
          const held = new Set(positions.map((p) => p.token))
          const candidates = labels.filter((l) => !held.has(l))
          if (candidates.length > 0) {
            const label = choice(candidates)
            const price = priceAt(label)
            const sizeFrac = clamp(0.03 + signal * 0.006, 0.015, 0.12)
            const notional = equity * sizeFrac
            const entryPrice = price * (1 + slippageFor(notional))
            positions.push({ token: label, entryPrice, peakPrice: entryPrice, units: notional / entryPrice, notional })
            fills += 1
            sessionEntries += 1
          }
        }
      }
    }

    peakEquity = Math.max(peakEquity, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0)
    if (i % sampleEvery === 0) equitySeries.push(equity)
  }

  equitySeries.push(equity)

  const totalTrades = wins + losses
  const totalPnl = equity - SEED_EQUITY
  const equityReturns = diffs(equitySeries)
  const sharpe = clamp(mean(equityReturns) / (stdDev(equityReturns) || 1), -3, 3)
  const virtualHours = (ticks * msPerCandle) / (60 * 60_000)

  return {
    virtualHours,
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
    source: 'real',
    symbol: labels.join('/'),
  }
}
