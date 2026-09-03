// Shared trading-rule tunables — the live engine (simulation.ts) and the
// headless backtester (backtest.ts) both import from here, so a parameter
// change always applies to both at once and the two can never quietly
// drift out of sync with each other.

import type { AgentId } from './types'

export const SEED_EQUITY = 5000
export const MAX_POSITIONS = 6

// Exit discipline: cut losers fast, let winners run uncapped (only a
// trailing stop, armed once meaningfully in profit, locks gains in).
// Tuned against a headless stats harness — a tight fixed take-profit
// amputates the fat right tail that this asset class's returns actually
// come from, while a trail that gives back more than it takes to arm can
// still lock in a net loss. TRAIL must stay well under TRAIL_ARM.
export const STOP_LOSS_PCT = 0.07
export const TRAIL_ARM_PCT = 0.1
export const TRAIL_GIVEBACK_PCT = 0.05
export const MOONSHOT_SAFETY_MULT = 2.5 // extreme-case cap only, almost never hit
export const ENTRY_REGIME_THRESHOLD = 0.08 // only buy when the shared market factor is favorable
export const RISK_VETO_CHANCE = 0.5 // chance RISK blocks a new entry while GUARDING

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
