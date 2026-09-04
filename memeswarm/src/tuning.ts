// Shared trading-rule tunables — the live engine (simulation.ts) and the
// headless backtester (backtest.ts) both import from here, so a parameter
// change always applies to both at once and the two can never quietly
// drift out of sync with each other.

import type { AgentId } from './types'

export const SEED_EQUITY = 5000
export const MAX_POSITIONS = 6

// Assumed real tradable depth of a typical meme-coin pool, used to scale
// slippage with position size (see slippageFor in simulation.ts/backtest.ts)
// so equity can't compound into an unbounded number by sizing an ever-larger
// dollar amount into the same shallow liquidity at a constant cost.
export const LIQUIDITY_DEPTH_USD = 400_000

// Exit discipline: cut losers fast, let winners run uncapped (only a
// trailing stop, armed once meaningfully in profit, locks gains in).
// Tuned against a headless stats harness — a tight fixed take-profit
// amputates the fat right tail that this asset class's returns actually
// come from, while a trail that gives back more than it takes to arm can
// still lock in a net loss. TRAIL must stay well under TRAIL_ARM.
//
// Re-tuned via a 486-config grid search (backtest.ts as the feedback loop,
// scored on 1-year runs, cross-checked at 24h/7d/30d): the single biggest
// lever was ENTRY_REGIME_THRESHOLD. At the old 0.08 the desk fired on almost
// any wobble — thousands of marginal trades a month, ~36% hit rate, and a
// long-run edge that was reliably negative (backtested -90% over a
// simulated year). Waiting for a much clearer regime (0.18) cuts trade
// volume by ~85% but lifts the hit rate to ~55-60% and turns Sharpe
// positive and stable across every horizon tested. STOP_LOSS tightened
// (0.07 -> 0.05) and TRAIL_GIVEBACK tightened (0.05 -> 0.025) so losers are
// cut faster and winners give back less before the trail locks them in —
// a meaningfully better risk:reward per trade on top of the entry filter.
export const STOP_LOSS_PCT = 0.05
export const TRAIL_ARM_PCT = 0.1
export const TRAIL_GIVEBACK_PCT = 0.025
export const MOONSHOT_SAFETY_MULT = 2.5 // extreme-case cap only, almost never hit
export const ENTRY_REGIME_THRESHOLD = 0.18 // only buy once the shared market factor is clearly, not marginally, favorable
export const RISK_VETO_CHANCE = 0.5 // chance RISK blocks a new entry while GUARDING
// SNIPER used to size by conviction but would still fire on a *negative*
// SCOUT/SENTIMENT/WHALE-WATCH reading (just smaller) — contradicts its own
// "only fires when the desk agrees" premise. Now a non-positive composite
// blocks the entry outright.
export const MIN_SIGNAL_THRESHOLD = 0

// How strongly each agent's "value" reading reacts to the shared market
// factor — used both for the live agent sparklines and (for scout/
// sentiment/whalewatch/liquidity) the backtester's simplified signal proxy.
export const AGENT_BETA: Record<AgentId, number> = {
  scout: 0.3,
  sniper: 0.9,
  sentiment: 0.6,
  whalewatch: 0.5,
  liquidity: 0.2,
  risk: -0.4,
  exit: 0.7,
  treasury: 0.15,
}
