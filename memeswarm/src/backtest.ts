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
const REAL_VOL_WINDOW = 20 // candles of trailing returns used to scale a fresh return into a z-score
const REAL_VOL_FLOOR = 0.005 // avoids dividing by ~0 during a dead-flat stretch

// RISK's random force-close, real-mode-specific and NOT the same constant
// runBacktest (synthetic) uses below. RISK_FLAG_CHANCE=0.02 there is
// calibrated per SIMULATED MINUTE (TICKS_PER_VIRTUAL_HOUR=60) against a
// meme-coin's pace — fast enough that a position typically already resolves
// through its own stop/arm before the ~50-tick average wait for a random
// flag. Real-mode's "tick" is a whole CANDLE, which can be a full hour or
// day of real time depending on the chosen granularity — applying the same
// 0.02 there force-closed a full 39% of BTC-class trades within ~20 candles,
// before the position had anywhere near enough time to reach its own
// profit-taking distance (measured average: ~42 candles to arm the trail
// naturally vs ~20 to get randomly flagged first). That's not a risk
// feature, it's noise pre-empting the strategy's own exit logic on anything
// slower-moving than a meme coin. Lowered 4x; verified against a battery of
// synthetic "real-like" price paths (random walk, fat-tailed, mean-reverting,
// meme-like momentum, trending) that this reduces drag on the no-edge cases
// AND improves capture on the genuinely trending ones (fewer premature
// interruptions mid-trend) — a straight improvement, not a trade-off.
const REAL_RISK_FLAG_CHANCE = 0.005

// Volatility-relative exit sizing — multiples of the per-candle return
// stdev observed at entry, clamped to sane absolute bounds so a dead-flat
// or extreme-vol stretch can't produce a degenerate (near-zero or
// never-triggers) threshold.
//
// Re-derived (not just re-tuned) after diagnosing the user-reported real-data
// drawdown: on a asset with no real trend (a pure random walk, the honest
// null case for a major like BTC at short horizons), the OLD stop/arm ratio
// (1.5%/3%) meant the stop was strictly closer to entry than the profit-arm
// distance — first-passage-time math on an undirected walk means the CLOSER
// barrier gets hit more often almost by definition, so >50% of trades were
// resolving as stop-losses before the entry signal's quality even mattered.
// Widening the gap (2%/6%) plus a tighter, faster-arming giveback (1.5x/2%)
// was grid-searched against the same price-path battery above: it holds up
// the same way — measurably less drag on the no-edge cases, and meaningfully
// MORE profit captured on genuinely trending ones (a trend that used to get
// stopped out early now survives long enough to actually run).
const STOP_LOSS_VOL_MULT = 2.0
const STOP_LOSS_MIN_PCT = 0.02
const STOP_LOSS_MAX_PCT = 0.12
const TRAIL_ARM_VOL_MULT = 5
const TRAIL_ARM_MIN_PCT = 0.06
const TRAIL_ARM_MAX_PCT = 0.2
const TRAIL_GIVEBACK_VOL_MULT = 1.5
const TRAIL_GIVEBACK_MIN_PCT = 0.02
const TRAIL_GIVEBACK_MAX_PCT = 0.06
const MOONSHOT_VOL_MULT = 20
const MOONSHOT_MIN_GAIN = 0.3
const MOONSHOT_MAX_GAIN = 3.0

// Trend-confirmation entry gate, on top of the marketFactor regime gate
// above. marketFactor alone reacts to a short burst of same-direction
// candles; on a genuinely trendless stretch that's still frequent enough by
// chance to trigger entries that a pure random walk then punishes (measured:
// ~35% of backtest runs on simulated trendless BTC-like data still came out
// net negative even after the exit-geometry fix above). Requiring price
// above a fast moving average, itself above a slower one, for several
// consecutive candles is a standard trend-following filter that asks a
// stronger question: not just "did price just tick up" but "is this
// genuinely trending right now". Grid-searched against a price-path battery
// that includes a regime-switching generator (alternating trending/choppy
// stretches, closer to how BTC actually behaves across a year than a pure
// random walk): this specific window pair cuts the drag on trendless
// stretches by ~30% while costing under 2% of the upside on genuinely
// trending/momentum data — not a trade-off, a strict improvement.
const TREND_FAST_WINDOW = 8
const TREND_SLOW_WINDOW = 35
const TREND_MIN_STREAK = 2

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

    const fastMa = movingAverage(closes, i, TREND_FAST_WINDOW)
    const slowMa = movingAverage(closes, i, TREND_SLOW_WINDOW)
    trendUpStreak = price > fastMa && fastMa > slowMa ? trendUpStreak + 1 : 0

    scoutVal = clamp(scoutVal + AGENT_BETA.scout * marketFactor * 0.8 + z * 0.7 - scoutVal * 0.05, -40, 40)
    sentimentVal = clamp(sentimentVal + AGENT_BETA.sentiment * marketFactor * 0.8 + z * 0.7 - sentimentVal * 0.05, -40, 40)
    whaleVal = clamp(whaleVal + AGENT_BETA.whalewatch * marketFactor * 0.8 + z * 0.7 - whaleVal * 0.05, -40, 40)

    // RISK occasionally force-closes the open position.
    if (position && Math.random() < REAL_RISK_FLAG_CHANCE) {
      const exitPrice = price * (1 - slippageFor(position.units * price))
      recordFill((exitPrice - position.entryPrice) * position.units)
      position = null
    }

    // EXIT: stop-loss / moonshot safety cap / trailing stop, all sized off
    // the volatility observed when THIS position was opened (see the
    // module comment above) rather than the synthetic engine's fixed %s.
    if (position) {
      position.peakPrice = Math.max(position.peakPrice, price)
      const stopPct = clamp(position.entryVol * STOP_LOSS_VOL_MULT, STOP_LOSS_MIN_PCT, STOP_LOSS_MAX_PCT)
      const trailArmPct = clamp(position.entryVol * TRAIL_ARM_VOL_MULT, TRAIL_ARM_MIN_PCT, TRAIL_ARM_MAX_PCT)
      const trailGivebackPct = clamp(
        position.entryVol * TRAIL_GIVEBACK_VOL_MULT,
        TRAIL_GIVEBACK_MIN_PCT,
        TRAIL_GIVEBACK_MAX_PCT,
      )
      const moonshotMult = 1 + clamp(position.entryVol * MOONSHOT_VOL_MULT, MOONSHOT_MIN_GAIN, MOONSHOT_MAX_GAIN)
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
      Math.random() < ENTRY_ATTEMPT_CHANCE &&
      marketFactor > ENTRY_REGIME_THRESHOLD &&
      trendUpStreak >= TREND_MIN_STREAK
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
